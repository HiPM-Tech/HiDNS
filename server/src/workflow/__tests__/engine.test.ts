import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowEngine, type WorkflowDefinition } from '../engine';
import { WorkflowEventBus, buildRecordEvent, type WorkflowEvent } from '../event-bus';
import { createDispatcher } from '../dispatch';
import type { AuthorizeDeps, Principal } from '../auth';
import { defineAction } from '../actions/types';

const principal: Principal = {
  kind: 'user',
  id: 'u1',
  role: 'user',
  services: ['records.write', 'records.read'],
  allowedDomains: '*',
};

function authDeps(overrides: Partial<AuthorizeDeps> = {}): AuthorizeDeps {
  return {
    lookupAction: (name) => ({ name, actionClass: 'dns.record.write', service: 'records.write', dslVisible: true }),
    audit: async () => undefined,
    rateLimit: () => true,
    now: () => 1_700_000_000_000,
    newTraceId: () => 'trace-1',
    ...overrides,
  };
}

function event(type: 'A' | 'AAAA' | 'CNAME' = 'A'): WorkflowEvent {
  return buildRecordEvent({
    action: 'updated',
    domain: { id: 1, name: 'example.com' },
    record: { id: 'r1', name: 'www', type, value: '1.2.3.4', oldValue: '5.6.7.8' },
  }) as WorkflowEvent;
}

function wf(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'wf1',
    name: 'wf',
    enabled: true,
    trigger: { type: 'record.changed', recordTypes: ['A', 'AAAA'] },
    actions: [{ kind: 'call', action: 'dns.record.update', args: { value: { kind: 'ref', path: 'event.record.value' } } }],
    ...overrides,
  };
}

describe('动作派发', () => {
  it('未授权动作不触达 handler', async () => {
    const handler = vi.fn(async () => 'x');
    const dispatch = createDispatcher({
      authorizeDeps: authDeps({ lookupAction: () => null }),
      lookupHandler: () => handler as never,
    });
    await expect(dispatch('dns.record.drop', principal, {})).rejects.toMatchObject({ status: 404 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('缺少实现时返回 500 而不是静默成功', async () => {
    const dispatch = createDispatcher({
      authorizeDeps: authDeps(),
      lookupHandler: () => null,
    });
    await expect(dispatch('dns.record.update', principal, {})).rejects.toMatchObject({ status: 500 });
  });

  it('通过鉴权后执行 handler', async () => {
    const handler = defineAction(async () => 'done');
    const dispatch = createDispatcher({ authorizeDeps: authDeps(), lookupHandler: () => handler });
    await expect(dispatch('dns.record.update', principal, { value: '1.1.1.1' })).resolves.toBe('done');
  });
});

describe('执行引擎', () => {
  let bus: WorkflowEventBus;
  beforeEach(() => {
    bus = new WorkflowEventBus();
  });

  type DispatchFn = (action: string, principal: Principal, args: Record<string, unknown>) => Promise<unknown>;

  function engine(workflows: WorkflowDefinition[], dispatch: DispatchFn | ReturnType<typeof vi.fn> = async () => 'ok', onRun = vi.fn()) {
    return new WorkflowEngine(
      {
        listWorkflows: async () => workflows,
        resolvePrincipal: async () => principal,
        dispatch: dispatch as unknown as DispatchFn,
        onRun,
      },
      bus,
    );
  }

  it('禁用工作流不执行', async () => {
    const dispatch = vi.fn(async () => 'ok');
    const runs = await engine([wf({ enabled: false })], dispatch).handleEvent(event());
    expect(runs).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('记录类型不匹配不执行', async () => {
    const dispatch = vi.fn(async () => 'ok');
    const runs = await engine([wf()], dispatch).handleEvent(event('AAAA'));
    expect(runs[0].status).toBe('success');
    const none = await engine([wf({ trigger: { type: 'record.changed', recordTypes: ['A'] } })], dispatch).handleEvent(event('AAAA'));
    expect(none).toEqual([]);
  });

  it('条件为假时标记 skipped', async () => {
    const dispatch = vi.fn(async () => 'ok');
    const runs = await engine(
      [wf({ condition: { kind: 'literal', value: false } })],
      dispatch,
    ).handleEvent(event());
    expect(runs[0].status).toBe('skipped');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('动作按顺序执行且变量可在步骤间传递', async () => {
    const dispatch = vi.fn(async () => 'ok');
    const runs = await engine(
      [
        wf({
          actions: [
            { kind: 'assign', key: 'ip', value: { kind: 'ref', path: 'event.record.value' } },
            { kind: 'call', action: 'dns.record.update', args: { value: { kind: 'ref', path: 'vars.ip' } } },
          ],
        }),
      ],
      dispatch,
    ).handleEvent(event());
    expect(runs[0].status).toBe('success');
    expect(dispatch).toHaveBeenCalledWith(
      'dns.record.update',
      principal,
      { value: '1.2.3.4' },
      expect.objectContaining({ trigger: 'event', triggerType: 'record.changed' }),
    );
  });

  it('单个工作流失败不影响其它工作流', async () => {
    const dispatch = vi.fn(async (action: string) => {
      if (action === 'dns.record.update') throw new Error('boom');
      return 'ok';
    });
    const runs = await engine(
      [
        wf({ id: 'bad' }),
        wf({ id: 'good', actions: [{ kind: 'call', action: 'dns.record.list', args: {} }] }),
      ],
      dispatch,
    ).handleEvent(event());
    expect(runs.map((r) => r.status)).toEqual(['failed', 'success']);
    expect(runs[0].error).toContain('boom');
  });

  it('start 订阅总线，stop 退订', async () => {
    const dispatch = vi.fn(async () => 'ok');
    const e = engine([wf()], dispatch);
    e.start();
    expect(bus.subscriberCount()).toBe(1);
    bus.publish(event());
    await new Promise((r) => setTimeout(r, 0));
    expect(dispatch).toHaveBeenCalled();
    e.stop();
    expect(bus.subscriberCount()).toBe(0);
  });

  it('未 start 时不订阅（无模块作用域副作用）', () => {
    engine([wf()]);
    expect(bus.subscriberCount()).toBe(0);
  });
});