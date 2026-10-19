import { describe, it, expect, vi } from 'vitest';
import {
  planGroupSync,
  planSyncSet,
  applySyncSet,
  selectGroupsForDomain,
  computeSyncSetDigest,
  normalizeAddressUpdate,
  type OriginGroupOps,
  type SyncRequest,
} from '../origin-group-sync';
import { OriginGroupError, type OriginGroup, type OriginRecord } from '../origin-group-core';

const V4_SLOT = '203.0.113.10';
const V4_NEXT = '203.0.113.20';
const V6_SLOT = '2001:db8::10';
const V6_NEXT = '2001:db8::20';

function rec(record: string, extra: Partial<OriginRecord> = {}): OriginRecord {
  return { record, type: 'IP_DOMAIN', ...extra };
}

function grp(
  records: OriginRecord[],
  refs: OriginGroup['references'] = [],
  overrides: Partial<OriginGroup> = {},
): OriginGroup {
  return { groupId: 'og-1', name: 'G1', type: 'HTTP', records, references: refs, ...overrides };
}

describe('地址校验', () => {
  it('拒绝空更新', () => {
    expect(() => normalizeAddressUpdate({})).toThrow(/至少需要一个地址族/);
  });

  it('族槽位不匹配直接拒绝', () => {
    expect(() => normalizeAddressUpdate({ v4: V6_SLOT })).toThrow(/IPv6 地址/);
    expect(() => normalizeAddressUpdate({ v6: V4_SLOT })).toThrow(/IPv4 地址/);
  });

  it('拒绝对内网地址做同步', () => {
    expect(() => normalizeAddressUpdate({ v4: '10.0.0.1' })).toThrow(/内网/);
    expect(() => normalizeAddressUpdate({ v6: 'fe80::1' })).toThrow(/内网/);
  });

  it('接受带方括号的 IPv6', () => {
    expect(normalizeAddressUpdate({ v6: '[2001:db8::1]' }).v6).toBe('2001:db8::1');
  });
});

describe('单组同步计划', () => {
  it('只替换 v4，v6 源站原样保留', () => {
    const group = grp([rec(V4_SLOT, { recordId: 'r1', weight: 30 }), rec(V6_SLOT, { recordId: 'r2' })]);
    const plan = planGroupSync(group, { v4: V4_NEXT });
    expect(plan.changed).toBe(true);
    expect(plan.blocked).toBe(false);
    expect(plan.after).toHaveLength(2);
    expect(plan.after[0]).toMatchObject({ record: V4_NEXT, recordId: 'r1', weight: 30 });
    expect(plan.after[1]).toMatchObject({ record: V6_SLOT, recordId: 'r2' });
    expect(plan.changes).toEqual([{ family: 'v4', from: [V4_SLOT], to: V4_NEXT }]);
  });

  it('A 与 AAAA 同时更新，一次计划全部覆盖', () => {
    const group = grp([rec(V4_SLOT, { recordId: 'r1' }), rec(V6_SLOT, { recordId: 'r2' })]);
    const plan = planGroupSync(group, { v4: V4_NEXT, v6: V6_NEXT });
    expect(plan.changes.map((c) => c.family).sort()).toEqual(['v4', 'v6']);
    expect(plan.after.map((r) => r.record)).toEqual([V4_NEXT, V6_NEXT]);
    expect(plan.after.map((r) => r.recordId)).toEqual(['r1', 'r2']);
  });

  it('域名型源站虽然也是 IP_DOMAIN，但不被地址同步触碰', () => {
    const group = grp([rec(V4_SLOT), rec('origin.example.com')]);
    const plan = planGroupSync(group, { v4: V4_NEXT });
    expect(plan.after[1].record).toBe('origin.example.com');
    expect(plan.after[1].type).toBe('IP_DOMAIN');
  });

  it('对象存储源站原样保留', () => {
    const group = grp([rec(V4_SLOT), { record: 'bucket.example.com', type: 'AWS_S3', private: true }]);
    const plan = planGroupSync(group, { v4: V4_NEXT });
    expect(plan.after[1]).toMatchObject({ record: 'bucket.example.com', type: 'AWS_S3', private: true });
  });

  it('保持记录顺序，不重排', () => {
    const group = grp([rec('origin.example.com'), rec(V4_SLOT), rec('backup.example.com')]);
    const plan = planGroupSync(group, { v4: V4_NEXT });
    expect(plan.after.map((r) => r.record)).toEqual(['origin.example.com', V4_NEXT, 'backup.example.com']);
  });

  it('已是目标值 → noop，不产生写入', () => {
    const group = grp([rec(V4_SLOT), rec(V6_SLOT)]);
    const plan = planGroupSync(group, { v4: V4_SLOT, v6: V6_SLOT });
    expect(plan.noop).toBe(true);
    expect(plan.changed).toBe(false);
    expect(plan.blocked).toBe(false);
  });

  it('同族多条默认视为歧义并阻断', () => {
    const group = grp([rec(V4_SLOT), rec('203.0.113.11')]);
    const plan = planGroupSync(group, { v4: V4_NEXT });
    expect(plan.blocked).toBe(true);
    expect(plan.skipped[0]).toMatchObject({ family: 'v4', code: 'FAMILY_AMBIGUOUS' });
    expect(plan.after.map((r) => r.record)).toEqual([V4_SLOT, '203.0.113.11']);
  });

  it('allowMultiple 时全部替换并放弃 RecordId 身份', () => {
    const group = grp([rec(V4_SLOT, { recordId: 'r1' }), rec('203.0.113.11', { recordId: 'r2' })]);
    const plan = planGroupSync(group, { v4: V4_NEXT }, { allowMultiple: true });
    expect(plan.blocked).toBe(false);
    expect(plan.after.map((r) => r.record)).toEqual([V4_NEXT, V4_NEXT]);
    expect(plan.after.map((r) => r.recordId)).toEqual([undefined, undefined]);
  });

  it('族缺失默认不新增', () => {
    const group = grp([rec(V4_SLOT)]);
    const plan = planGroupSync(group, { v6: V6_NEXT });
    expect(plan.blocked).toBe(true);
    expect(plan.skipped[0]).toMatchObject({ family: 'v6', code: 'FAMILY_ABSENT' });
    expect(plan.after).toHaveLength(1);
  });

  it('addIfMissing 时新增该族源站', () => {
    const group = grp([rec(V4_SLOT)]);
    const plan = planGroupSync(group, { v6: V6_NEXT }, { addIfMissing: true });
    expect(plan.blocked).toBe(false);
    expect(plan.after.map((r) => r.record)).toEqual([V4_SLOT, V6_NEXT]);
    expect(plan.changes[0]).toEqual({ family: 'v6', from: [], to: V6_NEXT });
  });

  it('onPartial=apply 时只应用可确定的地址族，并如实报告被跳过的族', () => {
    const group = grp([rec(V4_SLOT)]);
    const plan = planGroupSync(group, { v4: V4_NEXT, v6: V6_NEXT }, { onPartial: 'apply' });
    expect(plan.blocked).toBe(false);
    expect(plan.changed).toBe(true);
    expect(plan.after.map((r) => r.record)).toEqual([V4_NEXT]);
    expect(plan.skipped.map((s) => s.family)).toEqual(['v6']);
  });

  it('摘要对同输入稳定，目标变化则变化', () => {
    const group = grp([rec(V4_SLOT)]);
    const a = planGroupSync(group, { v4: V4_NEXT });
    const b = planGroupSync(group, { v4: V4_NEXT });
    const c = planGroupSync(group, { v4: '203.0.113.99' });
    expect(a.digest).toBe(b.digest);
    expect(a.digest).not.toBe(c.digest);
  });
});

describe('按域名扇出到多个源站组', () => {
  const refs = (name: string) => [{ type: 'acceleration-domain', id: 'd1', name }];

  it('命中所有引用该域名的组', () => {
    const groups = [
      grp([rec(V4_SLOT)], refs('www.example.com'), { groupId: 'og-a' }),
      grp([rec(V4_SLOT)], refs('WWW.EXAMPLE.COM'), { groupId: 'og-b' }),
      grp([rec(V4_SLOT)], refs('other.example.com'), { groupId: 'og-c' }),
    ];
    expect(selectGroupsForDomain(groups, 'www.example.com').map((g) => g.groupId)).toEqual(['og-a', 'og-b']);
  });

  it('空域名不命中任何组', () => {
    const groups = [grp([rec(V4_SLOT)], refs('www.example.com'))];
    expect(selectGroupsForDomain(groups, '')).toEqual([]);
  });
});

function fakeOps(groups: OriginGroup[]): OriginGroupOps & { written: Map<string, OriginRecord[]> } {
  const state = new Map(groups.map((g) => [g.groupId, g]));
  const written = new Map<string, OriginRecord[]>();
  let seq = 0;
  return {
    written,
    async get(groupId: string) {
      const found = state.get(groupId);
      return found ? { ...found, records: found.records.map((r) => ({ ...r })) } : null;
    },
    async replace(groupId: string, records: OriginRecord[]) {
      const found = state.get(groupId);
      if (!found) throw new Error('missing group ' + groupId);
      state.set(groupId, { ...found, records: records.map((r) => ({ ...r })) });
      written.set(groupId, records.map((r) => ({ ...r })));
      seq += 1;
      return { requestId: 'req-' + seq };
    },
  };
}

describe('批量计划与应用', () => {
  const base = (): OriginGroup[] => [
    grp([rec(V4_SLOT, { recordId: 'r1' }), rec(V6_SLOT, { recordId: 'r2' })], [], { groupId: 'og-a', name: 'A' }),
    grp([rec(V4_SLOT, { recordId: 'r3' })], [], { groupId: 'og-b', name: 'B' }),
  ];
  const request: SyncRequest = { groupIds: ['og-a', 'og-b'], update: { v4: V4_NEXT } };

  it('多组一次计划，逐组给出改动', async () => {
    const ops = fakeOps(base());
    const set = await planSyncSet(ops, request);
    expect(set.plans).toHaveLength(2);
    expect(set.applicable.map((p) => p.groupId)).toEqual(['og-a', 'og-b']);
    expect(set.hasBlocked).toBe(false);
  });

  it('组顺序不影响聚合摘要', async () => {
    const ops = fakeOps(base());
    const forward = await planSyncSet(ops, request);
    const backward = await planSyncSet(ops, { ...request, groupIds: ['og-b', 'og-a'] });
    expect(forward.digest).toBe(backward.digest);
    expect(computeSyncSetDigest([...forward.plans].reverse())).toBe(forward.digest);
  });

  it('重复 groupId 只处理一次', async () => {
    const ops = fakeOps(base());
    const set = await planSyncSet(ops, { ...request, groupIds: ['og-a', 'og-a', ' og-a '] });
    expect(set.plans).toHaveLength(1);
  });

  it('未指定组直接拒绝', async () => {
    const ops = fakeOps(base());
    await expect(planSyncSet(ops, { groupIds: [], update: { v4: V4_NEXT } })).rejects.toThrow(OriginGroupError);
  });

  it('组不存在直接报错', async () => {
    const ops = fakeOps(base());
    await expect(planSyncSet(ops, { groupIds: ['og-x'], update: { v4: V4_NEXT } })).rejects.toThrow(/不存在/);
  });

  it('摘要不一致拒绝写入', async () => {
    const ops = fakeOps(base());
    await expect(applySyncSet(ops, request, 'forged')).rejects.toThrow(/与预览不一致/);
    expect(ops.written.size).toBe(0);
  });

  it('存在被阻断的组时整批拒绝，一条都不写', async () => {
    const ops = fakeOps([
      grp([rec(V4_SLOT)], [], { groupId: 'og-a' }),
      grp([rec(V4_SLOT), rec('203.0.113.77')], [], { groupId: 'og-b' }),
    ]);
    const set = await planSyncSet(ops, request);
    expect(set.hasBlocked).toBe(true);
    await expect(applySyncSet(ops, request, set.digest)).rejects.toThrow(/无法处理的地址族/);
    expect(ops.written.size).toBe(0);
  });

  it('正常写入并回读校验，回传每组 requestId', async () => {
    const ops = fakeOps(base());
    const set = await planSyncSet(ops, request);
    const { results } = await applySyncSet(ops, request, set.digest);
    expect(results.map((r) => r.status)).toEqual(['applied', 'applied']);
    expect(results[0].requestId).toBe('req-1');
    expect(results[1].requestId).toBe('req-2');
    expect(ops.written.get('og-a')?.map((r) => r.record)).toEqual([V4_NEXT, V6_SLOT]);
    expect(ops.written.get('og-b')?.map((r) => r.record)).toEqual([V4_NEXT]);
  });

  it('再次应用同一请求 → 全部 noop，无写入', async () => {
    const ops = fakeOps(base());
    const set = await planSyncSet(ops, request);
    await applySyncSet(ops, request, set.digest);
    const before = ops.written.size;
    const again = await planSyncSet(ops, request);
    const { results } = await applySyncSet(ops, request, again.digest);
    expect(results.every((r) => r.status === 'noop')).toBe(true);
    expect(ops.written.size).toBe(before);
  });

  it('回读不一致时标记失败', async () => {
    const groups = base();
    const ops = fakeOps(groups);
    const brokenOps: OriginGroupOps = {
      get: ops.get,
      replace: async () => ({ requestId: 'req-x' }),
    };
    const set = await planSyncSet(brokenOps, request);
    const { results } = await applySyncSet(brokenOps, request, set.digest);
    expect(results[0].status).toBe('failed');
    expect(results[0].error).toMatch(/回读/);
  });

  it('stopOnError 默认在首个失败后停止', async () => {
    const groups = base();
    const ops = fakeOps(groups);
    const failing = new Set<string>();
    const wrapped: OriginGroupOps = {
      get: ops.get,
      replace: async (groupId, records) => {
        if (failing.has(groupId)) throw new Error('boom');
        return ops.replace(groupId, records);
      },
    };
    const set = await planSyncSet(wrapped, request);
    failing.add('og-a');
    const { results } = await applySyncSet(wrapped, request, set.digest);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('failed');
  });
});

describe('族内有多条源站（源站池）', () => {
  const pool = (): OriginGroup[] => [
    grp(
      [
        rec('203.0.113.1', { recordId: 'r1', weight: 30 }),
        rec('203.0.113.2', { recordId: 'r2', weight: 70 }),
      ],
      [],
      { groupId: 'og-1' },
    ),
  ];

  it('给旧值时只替换命中的那一条，池里其它记录原样保留', () => {
    const plan = planGroupSync(grp([
      rec('203.0.113.1', { recordId: 'r1', weight: 30 }),
      rec('203.0.113.2', { recordId: 'r2', weight: 70 }),
    ]), { v4: '198.51.100.1', from: { v4: '203.0.113.1' } });

    expect(plan.blocked).toBe(false);
    expect(plan.after.map((r) => r.record)).toEqual(['198.51.100.1', '203.0.113.2']);
    expect(plan.after.map((r) => r.recordId)).toEqual(['r1', 'r2']);
    expect(plan.after.map((r) => r.weight)).toEqual([30, 70]);
    expect(plan.changes).toEqual([{ family: 'v4', from: ['203.0.113.1'], to: '198.51.100.1' }]);
  });

  it('不给旧值时族内多条视为歧义并阻断，不猜', () => {
    const plan = planGroupSync(
      grp([rec('203.0.113.1'), rec('203.0.113.2')]),
      { v4: '198.51.100.1' },
    );
    expect(plan.blocked).toBe(true);
    expect(plan.skipped[0]).toMatchObject({ family: 'v4', code: 'FAMILY_AMBIGUOUS', blocking: true });
    expect(plan.after.map((r) => r.record)).toEqual(['203.0.113.1', '203.0.113.2']);
  });

  it('旧值未命中时视为未跟踪该地址，不阻断', () => {
    const plan = planGroupSync(
      grp([rec('203.0.113.1'), rec('203.0.113.2')]),
      { v4: '198.51.100.1', from: { v4: '203.0.113.99' } },
    );
    expect(plan.skipped[0]).toMatchObject({ family: 'v4', code: 'FROM_NOT_FOUND', blocking: false });
    expect(plan.blocked).toBe(false);
    expect(plan.changed).toBe(false);
    expect(plan.noop).toBe(true);
  });

  it('旧值命中但已是目标值 → noop', () => {
    const plan = planGroupSync(
      grp([rec('203.0.113.1'), rec('203.0.113.2')]),
      { v4: '203.0.113.1', from: { v4: '203.0.113.1' } },
    );
    expect(plan.noop).toBe(true);
    expect(plan.changed).toBe(false);
  });

  it('旧值族别不匹配直接报错', () => {
    expect(() =>
      planGroupSync(grp([rec('203.0.113.1')]), { v4: '198.51.100.1', from: { v4: '2001:db8::1' } }),
    ).toThrow(/旧值不是 IPv4/);
  });

  it('A/AAAA 各自独立：给 v4 旧值时不影响同族的 v6 记录', () => {
    const plan = planGroupSync(
      grp([rec('203.0.113.1'), rec('203.0.113.2'), rec('2001:db8::1'), rec('2001:db8::2')]),
      { v4: '198.51.100.1', from: { v4: '203.0.113.2' } },
    );
    expect(plan.after.map((r) => r.record)).toEqual([
      '203.0.113.1',
      '198.51.100.1',
      '2001:db8::1',
      '2001:db8::2',
    ]);
  });

  it('域名有两条 A 记录时，两条事件各自精确替换，最终都更新', async () => {
    const ops = fakeOps(pool());
    const first = await planSyncSet(ops, {
      groupIds: ['og-1'],
      update: { v4: '198.51.100.1', from: { v4: '203.0.113.1' } },
    });
    await applySyncSet(
      ops,
      { groupIds: ['og-1'], update: { v4: '198.51.100.1', from: { v4: '203.0.113.1' } } },
      first.digest,
    );

    const second = await planSyncSet(ops, {
      groupIds: ['og-1'],
      update: { v4: '198.51.100.2', from: { v4: '203.0.113.2' } },
    });
    const { results } = await applySyncSet(
      ops,
      { groupIds: ['og-1'], update: { v4: '198.51.100.2', from: { v4: '203.0.113.2' } } },
      second.digest,
    );
    expect(results[0].status).toBe('applied');

    const after = await ops.get('og-1');
    expect(after?.records.map((r) => r.record)).toEqual(['198.51.100.1', '198.51.100.2']);
    expect(after?.records.map((r) => r.recordId)).toEqual(['r1', 'r2']);
  });

  it('批量同步时，池组被精确替换、单条组按唯一值替换，互不干扰', async () => {
    const ops = fakeOps([
      grp([rec('203.0.113.1', { recordId: 'p1' }), rec('203.0.113.2', { recordId: 'p2' })], [], { groupId: 'og-pool' }),
      grp([rec('203.0.113.1', { recordId: 's1' })], [], { groupId: 'og-single' }),
    ]);
    const request: SyncRequest = {
      groupIds: ['og-pool', 'og-single'],
      update: { v4: '198.51.100.1', from: { v4: '203.0.113.1' } },
    };
    const set = await planSyncSet(ops, request);
    expect(set.hasBlocked).toBe(false);
    await applySyncSet(ops, request, set.digest);

    expect((await ops.get('og-pool'))?.records.map((r) => r.record)).toEqual(['198.51.100.1', '203.0.113.2']);
    expect((await ops.get('og-single'))?.records.map((r) => r.record)).toEqual(['198.51.100.1']);
  });
});

describe('并发：A 与 AAAA 作为两个独立事件同时到达', () => {
  const dual = (): OriginGroup[] => [
    grp([rec(V4_SLOT, { recordId: 'r1' }), rec(V6_SLOT, { recordId: 'r2' })], [], { groupId: 'og-1' }),
  ];
  const reqV4: SyncRequest = { groupIds: ['og-1'], update: { v4: V4_NEXT } };
  const reqV6: SyncRequest = { groupIds: ['og-1'], update: { v6: V6_NEXT } };

  it('两族分别提交都成功，最终两族都是新值，谁也没被丢弃', async () => {
    const ops = fakeOps(dual());
    const planV4 = await planSyncSet(ops, reqV4);
    const planV6 = await planSyncSet(ops, reqV6);

    await applySyncSet(ops, reqV4, planV4.digest);
    // v6 的作用域摘要只含 IPv6 记录，不受 v4 写入影响
    const { results } = await applySyncSet(ops, reqV6, planV6.digest);
    expect(results[0].status).toBe('applied');

    const after = await ops.get('og-1');
    expect(after?.records.map((r) => r.record)).toEqual([V4_NEXT, V6_NEXT]);
  });

  it('同族记录在预览后被改动则拒绝提交', async () => {
    const ops = fakeOps(dual());
    const plan = await planSyncSet(ops, reqV4);
    await ops.replace('og-1', [rec('203.0.113.55'), rec(V6_SLOT, { recordId: 'r2' })]);
    await expect(applySyncSet(ops, reqV4, plan.digest)).rejects.toThrow(/与预览不一致/);
  });

  it('无关族的漂移不改变作用域摘要，但会改变整组摘要', async () => {
    const before = planGroupSync(grp([rec(V4_SLOT), rec(V6_SLOT)]), { v4: V4_NEXT });
    const drifted = planGroupSync(grp([rec(V4_SLOT), rec('2001:db8::77')]), { v4: V4_NEXT });
    expect(drifted.digest).toBe(before.digest);
    expect(drifted.fullDigest).not.toBe(before.fullDigest);
  });
});
