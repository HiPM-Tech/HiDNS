import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 本文件的夹具按 DescribeOriginGroup（2022-09-01）的**真实响应结构**构造：
 *   - 组对象同时含 GroupId/OriginGroupId、Name/OriginGroupName
 *   - 引用元素键名为 InstanceId / InstanceName / InstanceType / ZoneId / ZoneName
 *   - Records[].PrivateParameters 无参数时是**空数组**，不是对象
 * 值一律用文档保留地址（203.0.113.0/24、example.com），结构保持原样。
 */

vi.mock('../../../service/dns-provider-service', () => ({
  DnsProviderService: { getAdapterByAccount: vi.fn() },
}));

vi.mock('../../../db/bal/business-adapter', () => ({
  DomainOperations: { getById: vi.fn() },
}));

vi.mock('../../../lib/dns/providers/tencenteo/adapter', () => {
  class TencenteoAdapter {
    static nextClient: unknown = null;
    zoneId = '';
    domain = '';
    setZoneInfo(zoneId: string, domain: string) {
      this.zoneId = zoneId;
      this.domain = domain;
    }
    originGroups() {
      return (this.constructor as unknown as { nextClient: unknown }).nextClient;
    }
  }
  return { TencenteoAdapter };
});

import {
  planCollapse,
  buildCollapsedRecords,
  hasIrrecoverableData,
  computePlanDigest,
  describeReferences,
  OriginGroupError,
  type OriginGroup,
} from '../../../lib/dns/providers/tencenteo/origin-group';
import { OriginGroupClient } from '../../../lib/dns/providers/tencenteo/origin-group-client';
import { ALL_ACTIONS, HANDLERS } from '../registry';
import { DnsProviderService } from '../../../service/dns-provider-service';
import { DomainOperations } from '../../../db/bal/business-adapter';
import { TencenteoAdapter } from '../../../lib/dns/providers/tencenteo/adapter';

function group(records: OriginGroup['records'], references: OriginGroup['references'] = []): OriginGroup {
  return { groupId: 'origin-1', name: 'eo-origin', type: 'GENERAL', records, references };
}

/** 真实响应：无私有参数的记录，PrivateParameters 为空数组 */
const RAW_RECORD_PLAIN = {
  Area: [],
  Port: 0,
  Private: false,
  PrivateParameters: [],
  Proto: 'HTTP',
  Record: '203.0.113.10',
  RecordId: 'record-1',
  Type: 'IP_DOMAIN',
  Weight: 100,
};

/** 真实响应：引用元素的键名是 Instance* */
const RAW_REFERENCE = {
  InstanceId: 'edge-1',
  InstanceName: 'www.example.com',
  InstanceType: 'acceleration-domain',
  ZoneId: 'zone-1',
  ZoneName: 'example.com',
};

const RAW_GROUP = {
  GroupId: 'og-prod',
  OriginGroupId: 'og-prod',
  Name: 'PROD',
  OriginGroupName: 'PROD',
  Type: 'HTTP',
  HostHeader: '',
  OriginType: 'self',
  ConfigurationType: 'weight',
  Records: [RAW_RECORD_PLAIN],
  References: [RAW_REFERENCE],
};

describe('源站组收敛计划', () => {
  it('N→1：逐条列出被移除记录', () => {
    const plan = planCollapse(
      group([
        { record: '203.0.113.1', type: 'IP_DOMAIN', weight: 30 },
        { record: '203.0.113.2', type: 'IP_DOMAIN', weight: 70 },
      ]),
      { record: '198.51.100.9', type: 'IP_DOMAIN' },
    );
    expect(plan.collapsedFrom).toBe(2);
    expect(plan.removed).toHaveLength(2);
    expect(plan.noop).toBe(false);
  });

  it('已是单条且等于目标 → noop（幂等）', () => {
    const plan = planCollapse(group([{ record: '198.51.100.9', type: 'IP_DOMAIN' }]), {
      record: '198.51.100.9',
      type: 'IP_DOMAIN',
    });
    expect(plan.noop).toBe(true);
    expect(plan.removed).toEqual([]);
  });

  it('内网/回环目标被拒绝', () => {
    for (const target of [
      '10.0.0.1',
      '127.0.0.1',
      '192.168.1.1',
      '169.254.1.1',
      '100.64.0.1',
      '172.16.0.1',
      '172.20.10.5',
      '172.31.255.254',
      '::1',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'localhost',
    ]) {
      expect(() => planCollapse(group([]), { record: target, type: 'IP_DOMAIN' })).toThrow(OriginGroupError);
    }
  });

  it('公网地址与正常域名不被误判为内网', () => {
    for (const target of ['203.0.113.10', '8.8.8.8', '172.15.0.1', '172.32.0.1', 'fd.example.com', 'fc.example.com']) {
      expect(() => planCollapse(group([]), { record: target, type: 'IP_DOMAIN' })).not.toThrow();
    }
  });

  it('对象存储源站不得作为收敛目标', () => {
    expect(() => planCollapse(group([]), { record: 'bucket.example.com', type: 'AWS_S3' })).toThrow(/对象存储/);
  });

  it('digest 对同一输入稳定，目标不同则变化', () => {
    const g = group([{ record: '203.0.113.1', type: 'IP_DOMAIN' }]);
    const a = planCollapse(g, { record: '198.51.100.9', type: 'IP_DOMAIN' });
    const b = planCollapse(g, { record: '198.51.100.9', type: 'IP_DOMAIN' });
    const c = planCollapse(g, { record: '198.51.100.10', type: 'IP_DOMAIN' });
    expect(a.digest).toBe(b.digest);
    expect(a.digest).not.toBe(c.digest);
  });

  it('被移除记录含对象存储源站时标记不可重建', () => {
    const plan = planCollapse(group([{ record: 'b.example.com', type: 'AWS_S3', private: true }]), {
      record: '198.51.100.9',
      type: 'IP_DOMAIN',
    });
    expect(hasIrrecoverableData(plan.removed)).toBe(true);
    expect(hasIrrecoverableData([])).toBe(false);
  });

  it('普通 IP 记录不算不可重建（空私有参数不得误报）', () => {
    expect(hasIrrecoverableData([{ record: '203.0.113.10', type: 'IP_DOMAIN' }])).toBe(false);
    expect(hasIrrecoverableData([{ record: '203.0.113.10', type: 'IP_DOMAIN', privateParameters: {} }])).toBe(false);
    expect(
      hasIrrecoverableData([{ record: '203.0.113.10', type: 'IP_DOMAIN', privateParameters: { SecretId: 'x' } }]),
    ).toBe(true);
  });

  it('收敛后只有一条且不带 weight', () => {
    const records = buildCollapsedRecords({ record: '198.51.100.9', type: 'IP_DOMAIN', weight: 50 });
    expect(records).toHaveLength(1);
    expect(records[0].weight).toBeUndefined();
  });

  it('保留引用方清单（影响面可见）', () => {
    const plan = planCollapse(
      group([{ record: '203.0.113.1', type: 'IP_DOMAIN' }], [
        { type: 'acceleration-domain', id: 'edge-1', name: 'www.example.com' },
      ]),
      { record: '198.51.100.9', type: 'IP_DOMAIN' },
    );
    expect(plan.preservedReferences).toHaveLength(1);
    expect(describeReferences(plan.preservedReferences)).toEqual(['www.example.com[acceleration-domain]']);
  });

  it('引用方描述在缺名字时回落到 ID，不产出空串', () => {
    expect(describeReferences([{ type: 'acceleration-domain', id: 'edge-9' }])).toEqual(['edge-9[acceleration-domain]']);
    expect(describeReferences([{ type: '', id: '' }])).toEqual(['(未知)']);
  });
});

describe('源站组 API 客户端', () => {
  it('list 按真实字段映射，引用取 Instance* 键', async () => {
    const call = vi.fn(async () => ({ OriginGroups: [RAW_GROUP], TotalCount: 1 }));
    const client = new OriginGroupClient(call as never, 'zone-1');
    const groups = await client.list();
    expect(call).toHaveBeenCalledWith('DescribeOriginGroup', expect.objectContaining({ ZoneId: 'zone-1' }));
    expect(groups[0].groupId).toBe('og-prod');
    expect(groups[0].name).toBe('PROD');
    expect(groups[0].type).toBe('HTTP');
    expect(groups[0].references).toEqual([
      {
        type: 'acceleration-domain',
        id: 'edge-1',
        name: 'www.example.com',
        zoneId: 'zone-1',
        zoneName: 'example.com',
      },
    ]);
  });

  it('空 HostHeader 映射为 undefined 而非空串', async () => {
    const client = new OriginGroupClient((async () => ({ OriginGroups: [RAW_GROUP], TotalCount: 1 })) as never, 'zone-1');
    const groups = await client.list();
    expect(groups[0].hostHeader).toBeUndefined();
  });

  it('PrivateParameters 为空数组时不产生私有参数', async () => {
    const client = new OriginGroupClient((async () => ({ OriginGroups: [RAW_GROUP], TotalCount: 1 })) as never, 'zone-1');
    const groups = await client.list();
    expect(groups[0].records[0].privateParameters).toBeUndefined();
    expect(hasIrrecoverableData(groups[0].records)).toBe(false);
  });

  it('私有参数为真实对象时保留并可判定不可重建', async () => {
    const raw = {
      ...RAW_GROUP,
      Records: [{ ...RAW_RECORD_PLAIN, Private: true, PrivateParameters: { SecretId: 'sid', Bucket: 'b' } }],
    };
    const client = new OriginGroupClient((async () => ({ OriginGroups: [raw], TotalCount: 1 })) as never, 'zone-1');
    const groups = await client.list();
    expect(groups[0].records[0].privateParameters).toEqual({ SecretId: 'sid', Bucket: 'b' });
    expect(hasIrrecoverableData(groups[0].records)).toBe(true);
  });

  it('list 自动翻页，不静默截断', async () => {
    const page1 = { OriginGroups: [{ ...RAW_GROUP, GroupId: 'og-1' }, { ...RAW_GROUP, GroupId: 'og-2' }], TotalCount: 3 };
    const page2 = { OriginGroups: [{ ...RAW_GROUP, GroupId: 'og-3' }], TotalCount: 3 };
    const call = vi.fn(async (_action: string, payload: { Offset?: number }) => (payload.Offset === 0 ? page1 : page2));
    const client = new OriginGroupClient(call as never, 'zone-1');
    const groups = await client.list({ limit: 2 });
    expect(groups.map((g) => g.groupId)).toEqual(['og-1', 'og-2', 'og-3']);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('单页即取满时不额外发请求', async () => {
    const call = vi.fn(async () => ({ OriginGroups: [RAW_GROUP], TotalCount: 1 }));
    const client = new OriginGroupClient(call as never, 'zone-1');
    await client.list({ limit: 20 });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('get 按源站组 ID 走 Filters 由 API 拉取', async () => {
    const call = vi.fn(async () => ({ OriginGroups: [RAW_GROUP], TotalCount: 1 }));
    const client = new OriginGroupClient(call as never, 'zone-1');
    const found = await client.get('og-prod');
    expect(call).toHaveBeenCalledWith(
      'DescribeOriginGroup',
      expect.objectContaining({
        ZoneId: 'zone-1',
        Filters: [{ Name: 'origin-group-id', Values: ['og-prod'] }],
      }),
    );
    expect(found?.groupId).toBe('og-prod');
  });

  it('get 未命中返回 null', async () => {
    const client = new OriginGroupClient((async () => ({ OriginGroups: [] })) as never, 'zone-1');
    await expect(client.get('nope')).resolves.toBeNull();
  });

  it('get 对服务端忽略 filter 的情况仍精确比对，不误取', async () => {
    const client = new OriginGroupClient(
      (async () => ({ OriginGroups: [{ ...RAW_GROUP, GroupId: 'og-other' }], TotalCount: 1 })) as never,
      'zone-1',
    );
    await expect(client.get('og-prod')).resolves.toBeNull();
  });

  it('get 空 ID 直接返回 null，不发请求', async () => {
    const call = vi.fn(async () => ({}));
    const client = new OriginGroupClient(call as never, 'zone-1');
    await expect(client.get('')).resolves.toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('replace 走 ModifyOriginGroup 且省略 weight 时不写入该字段', async () => {
    const call = vi.fn(async () => ({ RequestId: 'req-1' }));
    const client = new OriginGroupClient(call as never, 'zone-1');
    await client.replace('og-prod', [{ record: '198.51.100.9', type: 'IP_DOMAIN' }]);
    const payload = (call.mock.calls[0] as unknown[])[1] as { Records: Array<Record<string, unknown>> };
    expect(payload.Records).toHaveLength(1);
    expect('Weight' in payload.Records[0]).toBe(false);
  });

  it('replace 回传服务端 RequestId', async () => {
    const client = new OriginGroupClient((async () => ({ RequestId: 'req-abc' })) as never, 'zone-1');
    await expect(client.replace('og-prod', [{ record: '198.51.100.9', type: 'IP_DOMAIN' }])).resolves.toEqual({
      requestId: 'req-abc',
    });
  });
});

describe('写入闸门（能力层）', () => {
  const replaceHandler = HANDLERS['ext.tencenteo.originGroup.replace'];
  const planHandler = HANDLERS['ext.tencenteo.originGroup.plan'];

  // 注册表里的 handler 已被 wrap 成 (ctx, args)，ctx.principal 决定可写域名集合
  const ctx = {
    principal: { allowedDomainIds: [7], allowedWriteDomainIds: [7] },
  } as never;

  /** 有状态的假 TEO：写入后回读能看到新记录，才能真实覆盖"写后校验"这一步 */
  function stubAdapter(rawGroup: Record<string, unknown>) {
    // vi.mock 用无参桩类替换了真实适配器，但 TS 看到的是真实构造函数签名
    const FakeAdapter = TencenteoAdapter as unknown as new () => TencenteoAdapter;
    const adapter = new FakeAdapter();
    let current: Record<string, unknown> = { ...rawGroup };
    (TencenteoAdapter as unknown as { nextClient: unknown }).nextClient = new OriginGroupClient(
      (async (action: string, payload: Record<string, unknown>) => {
        if (action === 'ModifyOriginGroup') {
          current = { ...current, Records: payload.Records };
          return { RequestId: 'req-write-1' };
        }
        return { OriginGroups: [current], TotalCount: 1 };
      }) as never,
      'zone-1',
    );
    (DnsProviderService.getAdapterByAccount as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(
      adapter,
    );
  }

  beforeEach(() => {
    (DomainOperations.getById as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
      id: 7,
      name: 'example.com',
      account_id: 1,
      third_id: 'zone-1',
    });
  });

  it('被引用的组拒绝整组覆盖，且报出引用方', async () => {
    stubAdapter(RAW_GROUP);
    await expect(
      replaceHandler(ctx, { domainId: 7, groupId: 'og-prod', target: '198.51.100.9', collapse: true, diffDigest: 'x' }),
    ).rejects.toThrow(/被 1 个资源引用.*www\.example\.com/);
  });

  it('未被引用的普通组可写入并回传 requestId', async () => {
    const raw = { ...RAW_GROUP, References: [] };
    stubAdapter(raw);
    const plan = (await planHandler(ctx, { domainId: 7, groupId: 'og-prod', target: '198.51.100.9' })) as {
      digest: string;
      irrecoverable: boolean;
      referenced: boolean;
    };
    expect(plan.irrecoverable).toBe(false);
    expect(plan.referenced).toBe(false);

    const result = (await replaceHandler(ctx, {
      domainId: 7,
      groupId: 'og-prod',
      target: '198.51.100.9',
      collapse: true,
      diffDigest: plan.digest,
    })) as { requestId: string; collapsedFrom: number };
    expect(result.requestId).toBe('req-write-1');
    expect(result.collapsedFrom).toBe(1);
  });

  it('未声明 collapse 直接拒绝', async () => {
    stubAdapter({ ...RAW_GROUP, References: [] });
    await expect(replaceHandler(ctx, { domainId: 7, groupId: 'og-prod', target: '198.51.100.9' })).rejects.toThrow(
      /collapse: true/,
    );
  });

  it('digest 不一致时拒绝写入', async () => {
    stubAdapter({ ...RAW_GROUP, References: [] });
    await expect(
      replaceHandler(ctx, { domainId: 7, groupId: 'og-prod', target: '198.51.100.9', collapse: true, diffDigest: 'forged' }),
    ).rejects.toThrow(/diff 与预览不一致/);
  });

  it('plan 结果携带引用方清单', async () => {
    stubAdapter(RAW_GROUP);
    const plan = (await planHandler(ctx, { domainId: 7, groupId: 'og-prod', target: '198.51.100.9' })) as {
      referencing: string[];
      referenced: boolean;
    };
    expect(plan.referenced).toBe(true);
    expect(plan.referencing).toEqual(['www.example.com[acceleration-domain]']);
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
