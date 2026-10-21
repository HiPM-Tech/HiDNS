import { describe, it, expect, vi } from 'vitest';
import { buildMigrationReport, collectLegacyOriginGroupNodes } from '../migration-report';

const legacyCall = (domainId: number) => ({
  kind: 'call',
  action: 'ext.tencenteo.originGroup.plan',
  args: {
    domainId: { kind: 'literal', value: String(domainId) },
    groupId: { kind: 'literal', value: 'og-x' },
    target: { kind: 'literal', value: '1.1.1.1' },
  },
});

function deps(overrides: Partial<Parameters<typeof buildMigrationReport>[1]> = {}) {
  return {
    resolveDomainAccount: vi.fn(async () => ({ accountId: 9 })),
    accountLevel: vi.fn(async () => 'read' as const),
    listZones: vi.fn(async () => [{ zoneId: 'zone-1', zoneName: 'z1' }]),
    ...overrides,
  };
}

describe('迁移报告（设计 §904 兼容层）', () => {
  it('只挑出仍带 domainId 的源站组动作，新契约的不算', () => {
    const nodes = collectLegacyOriginGroupNodes([
      legacyCall(7),
      { kind: 'call', action: 'ext.tencenteo.originGroup.plan', args: { accountId: { kind: 'literal', value: '3' } } },
      { kind: 'call', action: 'dns.record.list', args: { domainId: { kind: 'literal', value: '7' } } },
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].domainId).toBe(7);
  });

  it('assign 包裹的 call 也要能找出来', () => {
    const nodes = collectLegacyOriginGroupNodes([
      { kind: 'assign', name: 'plan', value: legacyCall(7) },
    ]);
    expect(nodes).toHaveLength(1);
  });

  it('账号可见 → 生成候选站点', async () => {
    const d = deps();
    const report = await buildMigrationReport([{ id: 1, name: 'wf', actions: [legacyCall(7)] }], d);
    expect(report[0].actions[0]).toMatchObject({ accountId: 9, migratable: true });
    expect(d.listZones).toHaveBeenCalledWith(9, expect.anything());
  });

  it('账号不可见 → 候选站点为空、且**不打上游**（鉴权先于拉站点）', async () => {
    const listZones = vi.fn(async () => [{ zoneId: 'zone-9', zoneName: '别处的站点' }]);
    const d = deps({ accountLevel: vi.fn(async () => 'none' as const), listZones });
    const report = await buildMigrationReport([{ id: 2, name: 'wf2', actions: [legacyCall(7)] }], d);
    expect(report[0].actions[0]).toMatchObject({ migratable: false, candidateScopes: [] });
    // 这是本条用例的核心：看不到账号就绝不能拿它的凭据去 DescribeZones
    expect(listZones).not.toHaveBeenCalled();
  });

  it('解析失败时记录错误且不抛，报告仍返回', async () => {
    const d = deps({
      resolveDomainAccount: vi.fn(async () => {
        throw new Error('域名不存在');
      }),
    });
    const report = await buildMigrationReport([{ id: 3, name: 'wf3', actions: [legacyCall(7)] }], d);
    expect(report[0].actions[0]).toMatchObject({ migratable: false, error: '域名不存在' });
  });
});
