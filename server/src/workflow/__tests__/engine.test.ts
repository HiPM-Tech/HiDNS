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

  it('runSingle：禁用工作流也可手动运行（显式动作）', async () => {
    const dispatch = vi.fn(async () => 'ok');
    const e = engine([wf({ id: '7', enabled: false })], dispatch);
    const record = await e.runSingle('7', event());
    expect(record?.status).toBe('success');
    expect(dispatch).toHaveBeenCalled();
  });

  it('runSingle：未知 ID 返回 null', async () => {
    const e = engine([wf({ id: '7' })], vi.fn(async () => 'ok'));
    await expect(e.runSingle('999', event())).resolves.toBeNull();
  });

  it('runSingle：以 manual 通道派发，不走 event 通道', async () => {
    const dispatch = vi.fn(async () => 'ok');
    const e = engine([wf({ id: '7' })], dispatch);
    await e.runSingle('7', event());
    expect(dispatch).toHaveBeenLastCalledWith(
      'dns.record.update',
      principal,
      expect.anything(),
      expect.objectContaining({ trigger: 'manual', triggerType: 'manual' }),
    );
  });

  it('防循环：派发携带事件 traceId，深度为事件深度 + 1', async () => {
    const dispatch = vi.fn(async () => 'ok');
    const e = engine([wf({ id: '7' })], dispatch);
    await e.handleEvent(event());
    expect(dispatch).toHaveBeenLastCalledWith(
      'dns.record.update',
      principal,
      expect.anything(),
      expect.objectContaining({ traceId: expect.any(String), depth: 1 }),
    );
  });

  it('防循环：深层事件继续递增', async () => {
    const dispatch = vi.fn(async () => 'ok');
    const e = engine([wf({ id: '7' })], dispatch);
    const deep = { ...event(), depth: 3 } as WorkflowEvent;
    await e.handleEvent(deep);
    expect(dispatch).toHaveBeenLastCalledWith(
      'dns.record.update',
      principal,
      expect.anything(),
      expect.objectContaining({ depth: 4 }),
    );
  });

  it('运行记录携带触发事件快照（供 (...) 预览）', async () => {
    const onRun = vi.fn();
    const e = engine([wf({ id: '7' })], vi.fn(async () => 'ok'), onRun);
    const evt = event();
    await e.handleEvent(evt);
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ event: evt }));
  });

  it('失败与跳过同样携带事件快照', async () => {
    const onRun = vi.fn();
    const failing = engine([wf({ id: '7' })], vi.fn(async () => { throw new Error('x'); }), onRun);
    await failing.handleEvent(event());
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', event: expect.anything() }));

    const skipped = engine([wf({ id: '8', condition: { kind: 'literal', value: false } })], vi.fn(async () => 'ok'), onRun);
    await skipped.handleEvent(event());
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped', event: expect.anything() }));
  });

  it('runSingle：结果写入 onRun', async () => {
    const onRun = vi.fn();
    const e = engine([wf({ id: '7' })], vi.fn(async () => 'ok'), onRun);
    await e.runSingle('7', event());
    expect(onRun).toHaveBeenCalledWith(expect.objectContaining({ workflowId: '7', status: 'success' }));
  });

  it('防循环：自触发在运行期间被并发保护拦下（不会放大）', async () => {
    const loopBus = new WorkflowEventBus();
    loopBus.configure({ allowSelfTrigger: true });
    let dispatched = 0;
    const dispatch = vi.fn(async (_a: string, _p: unknown, _args: unknown, opts: { depth?: number }) => {
      dispatched += 1;
      // 模拟动作写入后再次发布事件，深度取自上下文
      loopBus.publish({ ...event(), depth: opts.depth ?? 0, actor: { source: 'workflow' } } as never);
      return 'ok';
    });
    const e = new WorkflowEngine(
      {
        listWorkflows: async () => [wf({ id: '7' })],
        resolvePrincipal: async () => principal,
        dispatch: dispatch as never,
      },
      loopBus,
    );
    e.start();
    loopBus.publish(event());
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 5));
    e.stop();
    // 动作内部发布的事件在上一次运行尚未结束时到达，被并发保护跳过；
    // 深度递增（depth+1）作为第二道防线，见下方两条单测。
    expect(dispatched).toBe(1);
  });

  it('域名触发器：字段过滤命中', async () => {
    const dispatch = vi.fn(async () => 'ok');
    const domainWf = wf({
      id: 'd1',
      trigger: { type: 'domain.changed', fields: ['remark'] },
      actions: [{ kind: 'call', action: 'dns.record.list', args: {} }],
    });
    const e = engine([domainWf], dispatch);
    const base = {
      type: 'domain.changed',
      action: 'updated',
      domain: { id: 1, name: 'a.com' },
      actor: { source: 'ui' },
      traceId: 't',
      at: '',
    };
    const hit = { ...base, changedFields: ['remark'] } as never;
    const miss = { ...base, changedFields: ['enabled'] } as never;
    expect((await e.handleEvent(hit))[0].status).toBe('success');
    expect(await e.handleEvent(miss)).toEqual([]);
  });

  it('并发保护：同一工作流上一次未完成时跳过', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dispatch = vi.fn(async () => { await gate; return 'ok'; });
    const e = engine([wf({ id: '7' })], dispatch);

    const first = e.handleEvent(event());
    await new Promise((r) => setTimeout(r, 0));
    const second = await e.handleEvent(event());
    expect(second[0].status).toBe('skipped');
    expect(second[0].error).toBe('concurrent-run');

    release();
    expect((await first)[0].status).toBe('success');
  });

  it('并发保护：运行结束后可再次执行', async () => {
    const dispatch = vi.fn(async () => 'ok');
    const e = engine([wf({ id: '7' })], dispatch);
    await e.handleEvent(event());
    const again = await e.handleEvent(event());
    expect(again[0].status).toBe('success');
  });

  it('租户边界：owner 无权访问事件域名 → skipped / no-domain-access', async () => {
    const dispatch = vi.fn(async () => 'ok');
    const e = new WorkflowEngine(
      {
        listWorkflows: async () => [wf({ id: '7' })],
        resolvePrincipal: async () => principal,
        dispatch: dispatch as never,
        canAccessDomain: async () => false,
      },
      bus,
    );
    const runs = await e.handleEvent(event());
    expect(runs[0].status).toBe('skipped');
    expect(runs[0].error).toBe('no-domain-access');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('租户边界：有权访问时正常执行', async () => {
    const dispatch = vi.fn(async () => 'ok');
    const e = new WorkflowEngine(
      {
        listWorkflows: async () => [wf({ id: '7' })],
        resolvePrincipal: async () => principal,
        dispatch: dispatch as never,
        canAccessDomain: async () => true,
      },
      bus,
    );
    const runs = await e.handleEvent(event());
    expect(runs[0].status).toBe('success');
  });

  it('求值预算是运行级：多根合计超限即失败', async () => {
    const dispatch = vi.fn(async () => 'ok');
    const call = { kind: 'call' as const, action: 'dns.record.list', args: {} };
    // 4 个根，每根 20 次调用，合计 80 > 50
    const roots = Array.from({ length: 4 }, () => ({
      kind: 'logic' as const,
      op: 'and' as const,
      args: Array.from({ length: 20 }, () => call),
    }));
    const e = engine([wf({ id: '7', actions: roots })], dispatch);
    const runs = await e.handleEvent(event());
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error).toContain('动作调用超过');
  });

  it('运行记录携带 depth（事件深度 + 1）', async () => {
    const e = engine([wf({ id: '7' })], vi.fn(async () => 'ok'));
    const runs = await e.handleEvent(event());
    expect(runs[0].depth).toBe(1);
  });

  it('超时返回 failed 记录而不是抛错（整批记录不丢）', async () => {
    const onRun = vi.fn();
    const dispatch = vi.fn(() => new Promise(() => undefined));
    const e = new WorkflowEngine(
      {
        listWorkflows: async () => [wf({ id: '7' })],
        resolvePrincipal: async () => principal,
        dispatch: dispatch as never,
        onRun,
        runTimeoutMs: 20,
      },
      bus,
    );
    const runs = await e.handleEvent(event());
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error).toContain('运行超时');
    expect(onRun).toHaveBeenCalled();
  });

  it('超时后底层未结束前，同目标的重入仍被挡住', async () => {
    let release: (() => void) | undefined;
    const dispatch = vi.fn(() => new Promise<string>((resolve) => { release = () => resolve('ok'); }));
    const e = new WorkflowEngine(
      {
        listWorkflows: async () => [wf({ id: '7' })],
        resolvePrincipal: async () => principal,
        dispatch: dispatch as never,
        runTimeoutMs: 10,
      },
      bus,
    );
    await e.handleEvent(event());
    const second = await e.handleEvent(event());
    expect(second[0].status).toBe('skipped');
    expect(second[0].error).toBe('concurrent-run');
    release?.();
  });

  it('未 start 时不订阅（无模块作用域副作用）', () => {
    engine([wf()]);
    expect(bus.subscriberCount()).toBe(0);
  });
});