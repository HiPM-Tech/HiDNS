import { describe, it, expect, vi } from 'vitest';
import {
  planCollapse,
  buildCollapsedRecords,
  hasIrrecoverableData,
  computePlanDigest,
  OriginGroupError,
  type OriginGroup,
} from '../../../lib/dns/providers/tencenteo/origin-group';
import { OriginGroupClient } from '../../../lib/dns/providers/tencenteo/origin-group-client';
import { ALL_ACTIONS, HANDLERS } from '../registry';

function group(records: OriginGroup['records'], references: OriginGroup['references'] = []): OriginGroup {
  return { groupId: 'origin-1', name: 'eo-origin', type: 'GENERAL', records, references };
}

describe('源站组收敛计划', () => {
  it('N→1：逐条列出被移除记录', () => {
    const plan = planCollapse(
      group([
        { record: '1.1.1.1', type: 'IP_DOMAIN', weight: 30 },
        { record: '2.2.2.2', type: 'IP_DOMAIN', weight: 70 },
      ]),
      { record: '9.9.9.9', type: 'IP_DOMAIN' },
    );
    expect(plan.collapsedFrom).toBe(2);
    expect(plan.removed).toHaveLength(2);
    expect(plan.removed.map((r) => r.record)).toEqual(['1.1.1.1', '2.2.2.2']);
    expect(plan.noop).toBe(false);
  });

  it('已是单条且等于目标 → noop（幂等）', () => {
    const plan = planCollapse(group([{ record: '9.9.9.9', type: 'IP_DOMAIN' }]), {
      record: '9.9.9.9',
      type: 'IP_DOMAIN',
    });
    expect(plan.noop).toBe(true);
    expect(plan.removed).toEqual([]);
  });

  it('内网/回环目标被拒绝', () => {
    for (const target of ['10.0.0.1', '127.0.0.1', '192.168.1.1', '::1', 'fe80::1', 'localhost']) {
      expect(() => planCollapse(group([]), { record: target, type: 'IP_DOMAIN' })).toThrow(OriginGroupError);
    }
  });

  it('对象存储源站不得作为收敛目标', () => {
    expect(() => planCollapse(group([]), { record: 'bucket.example.com', type: 'AWS_S3' })).toThrow(
      /对象存储/,
    );
  });

  it('digest 对同一输入稳定，目标不同则变化', () => {
    const g = group([{ record: '1.1.1.1', type: 'IP_DOMAIN' }]);
    const a = planCollapse(g, { record: '9.9.9.9', type: 'IP_DOMAIN' });
    const b = planCollapse(g, { record: '9.9.9.9', type: 'IP_DOMAIN' });
    const c = planCollapse(g, { record: '8.8.8.8', type: 'IP_DOMAIN' });
    expect(a.digest).toBe(b.digest);
    expect(a.digest).not.toBe(c.digest);
  });

  it('被移除记录含私有参数时标记不可重建', () => {
    const plan = planCollapse(
      group([{ record: 'b.example.com', type: 'AWS_S3', private: true }]),
      { record: '9.9.9.9', type: 'IP_DOMAIN' },
    );
    expect(hasIrrecoverableData(plan.removed)).toBe(true);
    expect(hasIrrecoverableData([])).toBe(false);
  });

  it('收敛后只有一条且不带 weight', () => {
    const records = buildCollapsedRecords({ record: '9.9.9.9', type: 'IP_DOMAIN', weight: 50 });
    expect(records).toHaveLength(1);
    expect(records[0].weight).toBeUndefined();
  });

  it('保留引用方清单（影响面可见）', () => {
    const plan = planCollapse(
      group([{ record: '1.1.1.1', type: 'IP_DOMAIN' }], [{ type: 'acceleration-domain', id: 'd1', name: 'a.com' }]),
      { record: '9.9.9.9', type: 'IP_DOMAIN' },
    );
    expect(plan.preservedReferences).toHaveLength(1);
  });
});

describe('源站组 API 客户端', () => {
  it('list 映射官方字段', async () => {
    const call = vi.fn(async () => ({
      OriginGroups: [{ GroupId: 'origin-1', Name: 'g', Type: 'HTTP', Records: [{ Record: '1.1.1.1', Type: 'IP_DOMAIN', Weight: 30 }], References: [{ Type: 'acceleration-domain', Id: 'd1' }] }],
    }));
    const client = new OriginGroupClient(call as never, 'zone-1');
    const groups = await client.list();
    expect(call).toHaveBeenCalledWith('DescribeOriginGroup', expect.objectContaining({ ZoneId: 'zone-1' }));
    expect(groups[0].groupId).toBe('origin-1');
    expect(groups[0].records[0].weight).toBe(30);
    expect(groups[0].references[0].id).toBe('d1');
  });

  it('get 按源站组 ID 走 Filters 由 API 拉取', async () => {
    const call = vi.fn(async () => ({
      OriginGroups: [{ GroupId: 'origin-1', Name: 'g', Type: 'GENERAL', Records: [] }],
    }));
    const client = new OriginGroupClient(call as never, 'zone-1');
    const group = await client.get('origin-1');
    expect(call).toHaveBeenCalledWith(
      'DescribeOriginGroup',
      expect.objectContaining({
        ZoneId: 'zone-1',
        Filters: [{ Name: 'origin-group-id', Values: ['origin-1'] }],
      }),
    );
    expect(group?.groupId).toBe('origin-1');
  });

  it('get 未命中返回 null', async () => {
    const client = new OriginGroupClient((async () => ({ OriginGroups: [] })) as never, 'zone-1');
    await expect(client.get('nope')).resolves.toBeNull();
  });

  it('get 对服务端忽略 filter 的情况仍精确比对，不误取', async () => {
    const client = new OriginGroupClient(
      (async () => ({ OriginGroups: [{ GroupId: 'origin-2', Name: 'other', Type: 'GENERAL', Records: [] }] })) as never,
      'zone-1',
    );
    await expect(client.get('origin-1')).resolves.toBeNull();
  });

  it('get 空 ID 直接返回 null，不发请求', async () => {
    const call = vi.fn(async () => ({}));
    const client = new OriginGroupClient(call as never, 'zone-1');
    await expect(client.get('')).resolves.toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('replace 走 ModifyOriginGroup 且省略 weight 时不写入该字段', async () => {
    const call = vi.fn(async () => ({}));
    const client = new OriginGroupClient(call as never, 'zone-1');
    await client.replace('origin-1', [{ record: '9.9.9.9', type: 'IP_DOMAIN' }]);
    const payload = (call.mock.calls[0] as unknown[])[1] as { Records: Array<Record<string, unknown>> };
    expect(payload.Records).toHaveLength(1);
    expect('Weight' in payload.Records[0]).toBe(false);
  });
});

describe('扩展能力已进入注册表', () => {
  it('四个源站组动作都已声明且有 handler', () => {
    const names = ALL_ACTIONS.map((a) => a.name).filter((n) => n.startsWith('ext.tencenteo.originGroup.'));
    expect(names.sort()).toEqual([
      'ext.tencenteo.originGroup.get',
      'ext.tencenteo.originGroup.list',
      'ext.tencenteo.originGroup.plan',
      'ext.tencenteo.originGroup.replace',
    ]);
    for (const name of names) expect(HANDLERS[name]).toBeTypeOf('function');
  });

  it('写动作分类为 ext.write，读动作为 ext.read', () => {
    const byName = new Map(ALL_ACTIONS.map((a) => [a.name, a]));
    expect(byName.get('ext.tencenteo.originGroup.replace')?.actionClass).toBe('ext.write');
    expect(byName.get('ext.tencenteo.originGroup.list')?.actionClass).toBe('ext.read');
  });
});