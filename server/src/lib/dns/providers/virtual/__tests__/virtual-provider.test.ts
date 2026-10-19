import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { VirtualAdapter } from '../adapter';
import { VirtualStore } from '../store';
import { createVirtualTeoCall } from '../origin-api';
import { planSyncSet, applySyncSet, selectGroupsForDomain } from '../../../origin-group-sync';

const V4_NEXT = '203.0.113.20';
const V6_NEXT = '2001:db8::20';

function makeAdapter(overrides: Record<string, string> = {}): VirtualAdapter {
  return new VirtualAdapter({
    virtual_enabled: 'true',
    virtual_state: 'memory',
    virtual_seed: 'demo',
    virtual_tenant: 'test',
    domain: 'example.test',
    zoneId: 'virtual-zone-1',
    ...overrides,
  });
}

beforeEach(() => {
  VirtualStore.resetMemoryCache();
});

afterEach(() => {
  delete process.env.HIDNS_DISABLE_VIRTUAL_PROVIDER;
  VirtualStore.resetMemoryCache();
});

describe('虚拟提供商启用开关', () => {
  it('未显式启用时 check 失败并给出原因', async () => {
    const adapter = makeAdapter({ virtual_enabled: 'false' });
    await expect(adapter.check()).resolves.toBe(false);
    expect(adapter.getError()).toMatch(/未启用/);
  });

  it('未启用时任何操作都被拒绝', async () => {
    const adapter = makeAdapter({ virtual_enabled: '' });
    await expect(adapter.getDomainList()).rejects.toThrow(/未启用/);
    expect(() => adapter.originGroups()).toThrow(/未启用/);
  });

  it('进程级硬开关可一键停用', async () => {
    process.env.HIDNS_DISABLE_VIRTUAL_PROVIDER = '1';
    const adapter = makeAdapter();
    await expect(adapter.check()).resolves.toBe(false);
    await expect(adapter.getDomainList()).rejects.toThrow(/未启用/);
  });

  it('启用后 check 成功', async () => {
    await expect(makeAdapter().check()).resolves.toBe(true);
  });
});

describe('虚拟解析记录', () => {
  it('列出演示站点', async () => {
    const { total, list } = await makeAdapter().getDomainList();
    expect(total).toBe(1);
    expect(list[0]).toMatchObject({ Domain: 'example.test', ThirdId: 'virtual-zone-1' });
  });

  it('按类型过滤记录', async () => {
    const { list } = await makeAdapter().getDomainRecords(1, 100, undefined, undefined, undefined, 'AAAA');
    expect(list).toHaveLength(1);
    expect(list[0].Value).toBe('2001:db8::10');
  });

  it('新增、更新、删除记录闭环', async () => {
    const adapter = makeAdapter();
    const id = await adapter.addDomainRecord('api', 'A', '203.0.113.30');
    expect(id).toBeTruthy();
    expect((await adapter.getDomainRecordInfo(id!))?.Value).toBe('203.0.113.30');

    await adapter.updateDomainRecord(id!, 'api', 'A', '203.0.113.31');
    expect((await adapter.getDomainRecordInfo(id!))?.Value).toBe('203.0.113.31');

    await adapter.deleteDomainRecord(id!);
    expect(await adapter.getDomainRecordInfo(id!)).toBeNull();
  });

  it('记录状态可切换', async () => {
    const adapter = makeAdapter();
    await adapter.setDomainRecordStatus('vr-www', 0);
    expect((await adapter.getDomainRecordInfo('vr-www'))?.Status).toBe(0);
  });

  it('更新不存在的记录返回 false 而非抛错', async () => {
    const adapter = makeAdapter();
    await expect(adapter.updateDomainRecord('nope', 'a', 'A', '203.0.113.1')).resolves.toBe(false);
  });
});

describe('虚拟源站组：复用真实映射代码', () => {
  it('OriginGroupClient 能正确映射虚拟源站组', async () => {
    const ops = makeAdapter().originGroups();
    const groups = await ops.list({ limit: 100 });
    expect(groups).toHaveLength(3);
    const dual = groups.find((g) => g.name === 'DEMO-DUAL')!;
    expect(dual.records.map((r) => r.record)).toEqual(['203.0.113.10', '2001:db8::10']);
    expect(dual.references.map((r) => r.name)).toEqual(['example.test', 'www.example.test']);
    expect(dual.hostHeader).toBeUndefined();
  });

  it('按 ID 精确取组', async () => {
    const ops = makeAdapter().originGroups();
    await expect(ops.get('og-demo-dual')).resolves.toMatchObject({ groupId: 'og-demo-dual' });
    await expect(ops.get('og-missing')).resolves.toBeNull();
  });

  it('虚拟 API 对不存在的站点报错', async () => {
    const call = createVirtualTeoCall(new VirtualStore('test', { persistent: false }));
    await expect(call('DescribeOriginGroup', { ZoneId: 'nope' })).rejects.toThrow(/站点不存在/);
  });

  it('虚拟 API 拒绝清空源站组', async () => {
    const call = createVirtualTeoCall(new VirtualStore('test', { persistent: false }));
    await expect(
      call('ModifyOriginGroup', { ZoneId: 'virtual-zone-1', GroupId: 'og-demo-dual', Records: [] }),
    ).rejects.toThrow(/至少需要一条/);
  });
});

describe('一个域名扇出到多个源站组 + A/AAAA 同时更新', () => {
  it('演示数据里同一个域名被两个源站组引用', async () => {
    const groups = await makeAdapter().originGroups().list({ limit: 100 });
    const targets = selectGroupsForDomain(groups, 'example.test');
    expect(targets.map((g) => g.groupId).sort()).toEqual(['og-demo-dual', 'og-demo-v4only']);
  });

  it('默认失败关闭：其中一个组缺少 IPv6 时整批阻断', async () => {
    const ops = makeAdapter().originGroups();
    const groups = await ops.list({ limit: 100 });
    const groupIds = selectGroupsForDomain(groups, 'example.test').map((g) => g.groupId);
    const set = await planSyncSet(ops, { groupIds, update: { v4: V4_NEXT, v6: V6_NEXT } });

    expect(set.hasBlocked).toBe(true);
    const v4only = set.plans.find((p) => p.groupId === 'og-demo-v4only')!;
    expect(v4only.skipped[0]).toMatchObject({ family: 'v6', code: 'FAMILY_ABSENT' });

    await expect(applySyncSet(ops, { groupIds, update: { v4: V4_NEXT, v6: V6_NEXT } }, set.digest)).rejects.toThrow(
      /无法处理的地址族/,
    );
    const after = await ops.get('og-demo-dual');
    expect(after?.records[0].record).toBe('203.0.113.10'); // 一条都没写
  });

  it('显式允许补 IPv6 后，A 与 AAAA 一次写完，两组同时更新', async () => {
    const ops = makeAdapter().originGroups();
    const groups = await ops.list({ limit: 100 });
    const groupIds = selectGroupsForDomain(groups, 'example.test').map((g) => g.groupId);
    const request = { groupIds, update: { v4: V4_NEXT, v6: V6_NEXT }, options: { addIfMissing: true } };

    const set = await planSyncSet(ops, request);
    expect(set.hasBlocked).toBe(false);

    const { results } = await applySyncSet(ops, request, set.digest);
    expect(results.map((r) => r.status)).toEqual(['applied', 'applied']);
    expect(results.every((r) => Boolean(r.requestId))).toBe(true);

    const dual = await ops.get('og-demo-dual');
    expect(dual?.records.map((r) => r.record)).toEqual([V4_NEXT, V6_NEXT]);
    expect(dual?.records.map((r) => r.recordId)).toEqual(['ogr-dual-v4', 'ogr-dual-v6']);

    const v4only = await ops.get('og-demo-v4only');
    expect(v4only?.records.map((r) => r.record)).toEqual([V4_NEXT, V6_NEXT]);
  });

  it('未被引用的组完全不参与，且域名型源站不被改动', async () => {
    const ops = makeAdapter().originGroups();
    const groups = await ops.list({ limit: 100 });
    const groupIds = selectGroupsForDomain(groups, 'example.test').map((g) => g.groupId);
    const request = { groupIds, update: { v4: V4_NEXT }, options: { addIfMissing: true } };
    const set = await planSyncSet(ops, request);
    await applySyncSet(ops, request, set.digest);

    const mixed = await ops.get('og-demo-mixed');
    expect(mixed?.records.map((r) => r.record)).toEqual(['203.0.113.10', 'origin.example.test']);
  });

  it('重复执行同一请求为幂等 noop', async () => {
    const ops = makeAdapter().originGroups();
    const groups = await ops.list({ limit: 100 });
    const groupIds = selectGroupsForDomain(groups, 'example.test').map((g) => g.groupId);
    const request = { groupIds, update: { v4: V4_NEXT, v6: V6_NEXT }, options: { addIfMissing: true } };
    const first = await planSyncSet(ops, request);
    await applySyncSet(ops, request, first.digest);

    const second = await planSyncSet(ops, request);
    const { results } = await applySyncSet(ops, request, second.digest);
    expect(results.every((r) => r.status === 'noop')).toBe(true);
  });

  it('只改 AAAA 时不触碰 IPv4 源站', async () => {
    const ops = makeAdapter().originGroups();
    const request = { groupIds: ['og-demo-dual'], update: { v6: V6_NEXT } };
    const set = await planSyncSet(ops, request);
    expect(set.plans[0].after.map((r) => r.record)).toEqual(['203.0.113.10', V6_NEXT]);
    await applySyncSet(ops, request, set.digest);
    const dual = await ops.get('og-demo-dual');
    expect(dual?.records.map((r) => r.record)).toEqual(['203.0.113.10', V6_NEXT]);
  });
});
