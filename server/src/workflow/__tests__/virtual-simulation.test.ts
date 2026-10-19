import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AnyDomainEvent } from '../../lib/domain-event-bus';
import { createDispatcher, type Dispatcher } from '../dispatch';
import { lookupActionMeta } from '../actions/registry';
import { evaluate } from '../expression/evaluator';
import type { Principal } from '../auth';
import { VIRTUAL_DDNS_ORIGIN_SYNC } from '../presets/virtual-ddns-origin-sync';
import { VirtualAdapter } from '../../lib/dns/providers/virtual/adapter';
import { VirtualStore } from '../../lib/dns/providers/virtual/store';
import { DnsProviderService } from '../../service/dns-provider-service';
import { DomainOperations } from '../../db/bal/business-adapter';
import { setRecordDeps, resetRecordDeps } from '../actions/dns/record-deps';

vi.mock('../../service/dns-provider-service', () => ({
  DnsProviderService: { getAdapterByAccount: vi.fn() },
}));

vi.mock('../../db/bal/business-adapter', () => ({
  DomainOperations: { getById: vi.fn() },
}));

const DOMAIN_ID = 7;
const DOMAIN_NAME = 'example.test';
const ZONE_ID = 'virtual-zone-1';

const principal: Principal = {
  kind: 'user',
  id: '1',
  role: 'admin',
  services: ['records.read', 'records.write'],
  allowedDomainIds: [DOMAIN_ID],
  allowedWriteDomainIds: [DOMAIN_ID],
  allowedDomains: [DOMAIN_NAME],
};

function makeDispatcher(): Dispatcher {
  return createDispatcher({
    authorizeDeps: {
      lookupAction: lookupActionMeta,
      audit: async () => undefined,
      rateLimit: () => true,
      now: () => Date.now(),
      newTraceId: () => 'trace-test',
    },
  });
}

/** 按引擎的方式执行：条件求值 → 顺序执行动作，共享 vars */
async function runWorkflow(
  dispatch: Dispatcher,
  event: UnknownRecordEvent,
): Promise<{ status: 'success' | 'skipped'; vars: Record<string, unknown> }> {
  const vars: Record<string, unknown> = {};
  const ctx = {
    event: event as unknown as Readonly<Record<string, unknown>>,
    vars,
    call: (action: string, args: Record<string, unknown>) =>
      dispatch(action, principal, args, { trigger: 'event', triggerType: 'record.changed' }),
  };
  if (VIRTUAL_DDNS_ORIGIN_SYNC.condition) {
    const ok = await evaluate(VIRTUAL_DDNS_ORIGIN_SYNC.condition, ctx);
    if (!ok) return { status: 'skipped', vars };
  }
  for (const node of VIRTUAL_DDNS_ORIGIN_SYNC.actions) {
    await evaluate(node, ctx);
  }
  return { status: 'success', vars };
}

interface UnknownRecordEvent {
  type: 'record.changed';
  action: 'created' | 'updated' | 'deleted' | 'status_changed';
  domain: { id: number; name: string; accountId?: number };
  record: { id: string; name: string; type: 'A' | 'AAAA'; value?: string; oldValue?: string };
  actor: { source: 'api' };
  traceId: string;
  depth: number;
  at: string;
}

function recordEvent(
  action: UnknownRecordEvent['action'],
  type: 'A' | 'AAAA',
  value?: string,
): UnknownRecordEvent {
  return {
    type: 'record.changed',
    action,
    domain: { id: DOMAIN_ID, name: DOMAIN_NAME, accountId: 1 },
    record: { id: 'vr-1', name: '@', type, value },
    actor: { source: 'api' },
    traceId: 'trace-event',
    depth: 0,
    at: new Date().toISOString(),
  };
}

function adapter(): VirtualAdapter {
  return new VirtualAdapter({
    virtual_enabled: 'true',
    virtual_state: 'memory',
    virtual_seed: 'demo',
    virtual_tenant: 'sim',
    domain: DOMAIN_NAME,
    zoneId: ZONE_ID,
  });
}

beforeEach(() => {
  VirtualStore.resetMemoryCache();
  (DnsProviderService.getAdapterByAccount as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(
    adapter(),
  );
  (DomainOperations.getById as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
    id: DOMAIN_ID,
    name: DOMAIN_NAME,
    account_id: 1,
    third_id: ZONE_ID,
  });
});

beforeEach(() => {
  setRecordDeps({
    resolveDomain: async () => ({ id: DOMAIN_ID, name: DOMAIN_NAME, account_id: 1 }),
    getAdapter: async () => adapter(),
    publish: () => undefined,
  });
});

afterEach(() => {
  resetRecordDeps();
  VirtualStore.resetMemoryCache();
});

describe('虚拟模拟工作流：DDNS 变更 → 多个源站组', () => {
  it('A 记录更新后，引用该域名的两个源站组的 IPv4 源站都被同步', async () => {
    const dispatch = makeDispatcher();
    const { status, vars } = await runWorkflow(dispatch, recordEvent('updated', 'A', '203.0.113.20'));
    expect(status).toBe('success');
    expect(vars.plan).toMatchObject({ hasBlocked: false });

    const ops = adapter().originGroups();
    const dual = await ops.get('og-demo-dual');
    const v4only = await ops.get('og-demo-v4only');
    // A 变更只带 v4：dual 保留原 IPv6，v4only 也不会被凭空补出一条 IPv6 源站
    expect(dual?.records.map((r) => r.record)).toEqual(['203.0.113.20', '2001:db8::10']);
    expect(v4only?.records.map((r) => r.record)).toEqual(['203.0.113.20']);
  });

  it('AAAA 记录更新时只动 IPv6 源站，IPv4 保持不变', async () => {
    const dispatch = makeDispatcher();
    await runWorkflow(dispatch, recordEvent('updated', 'AAAA', '2001:db8::99'));

    const ops = adapter().originGroups();
    const dual = await ops.get('og-demo-dual');
    expect(dual?.records.map((r) => r.record)).toEqual(['203.0.113.10', '2001:db8::99']);
  });

  it('A 与 AAAA 先后更新，最终两组都持有新地址且互不覆盖', async () => {
    const dispatch = makeDispatcher();
    await runWorkflow(dispatch, recordEvent('updated', 'A', '203.0.113.20'));
    await runWorkflow(dispatch, recordEvent('updated', 'AAAA', '2001:db8::99'));

    const ops = adapter().originGroups();
    const dual = await ops.get('og-demo-dual');
    expect(dual?.records.map((r) => r.record)).toEqual(['203.0.113.20', '2001:db8::99']);
  });

  it('未被引用的源站组与域名型源站完全不动', async () => {
    const dispatch = makeDispatcher();
    await runWorkflow(dispatch, recordEvent('updated', 'A', '203.0.113.20'));

    const mixed = await adapter().originGroups().get('og-demo-mixed');
    expect(mixed?.records.map((r) => r.record)).toEqual(['203.0.113.10', 'origin.example.test']);
  });

  it('记录删除不触发同步（条件不满足则跳过）', async () => {
    const dispatch = makeDispatcher();
    const { status } = await runWorkflow(dispatch, recordEvent('deleted', 'A', '203.0.113.10'));
    expect(status).toBe('skipped');

    const dual = await adapter().originGroups().get('og-demo-dual');
    expect(dual?.records.map((r) => r.record)).toEqual(['203.0.113.10', '2001:db8::10']);
  });

  it('重复执行同一变更不产生额外写入', async () => {
    const dispatch = makeDispatcher();
    await runWorkflow(dispatch, recordEvent('updated', 'A', '203.0.113.20'));
    const first = await adapter().originGroups().get('og-demo-dual');

    const { vars } = await runWorkflow(dispatch, recordEvent('updated', 'A', '203.0.113.20'));
    const plans = (vars.plan as { plans: Array<{ changed: boolean }> }).plans;
    expect(plans.every((p) => p.changed === false)).toBe(true);

    const second = await adapter().originGroups().get('og-demo-dual');
    expect(second?.records).toEqual(first?.records);
  });

  it('目标为内网地址时整条流程拒绝，不写任何源站组', async () => {
    const dispatch = makeDispatcher();
    await expect(runWorkflow(dispatch, recordEvent('updated', 'A', '10.0.0.1'))).rejects.toThrow(/内网/);

    const dual = await adapter().originGroups().get('og-demo-dual');
    expect(dual?.records.map((r) => r.record)).toEqual(['203.0.113.10', '2001:db8::10']);
  });

  it('工作流也能通过 dns.record.update 改写虚拟域名的解析记录', async () => {
    const dispatch = makeDispatcher();
    await dispatch(
      'dns.record.update',
      principal,
      { domain: DOMAIN_NAME, recordId: 'vr-a', value: '203.0.113.77' },
      { trigger: 'event', triggerType: 'record.changed' },
    );
    const record = await adapter().getDomainRecordInfo('vr-a');
    expect(record?.Value).toBe('203.0.113.77');
    expect(record?.Type).toBe('A');
  });

  it('工作流声明的动作全部在注册表中且对 DSL 可见', () => {
    const called = new Set<string>();
    for (const node of VIRTUAL_DDNS_ORIGIN_SYNC.actions) {
      if (node.kind === 'call') called.add(node.action);
      if (node.kind === 'assign' && node.value.kind === 'call') called.add(node.value.action);
    }
    expect([...called].sort()).toEqual([
      'ext.virtual.originGroup.planSync',
      'ext.virtual.originGroup.sync',
    ]);
    for (const action of called) {
      const meta = lookupActionMeta(action);
      expect(meta, action).not.toBeNull();
      expect(meta!.dslVisible).toBe(true);
    }
  });
});
