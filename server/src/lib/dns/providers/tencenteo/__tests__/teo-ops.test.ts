import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { requestJsonMock } = vi.hoisted(() => ({ requestJsonMock: vi.fn() }));

vi.mock('../../http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../http')>();
  return { ...actual, requestJson: requestJsonMock };
});

vi.mock('../../../../../service/dns-provider-service', () => ({
  DnsProviderService: { getAdapterByAccount: vi.fn() },
}));

vi.mock('../../../../../db/bal/business-adapter', () => ({
  DomainOperations: { getById: vi.fn() },
  DnsAccountOperations: { getById: vi.fn() },
}));

import { listTeoZones, teoOpsForDomain } from '../teo-ops';
import { TencenteoAdapter } from '../adapter';
import { DnspodAdapter } from '../../dnspod/adapter';
import { DnsProviderService } from '../../../../../service/dns-provider-service';
import { DnsAccountOperations, DomainOperations } from '../../../../../db/bal/business-adapter';
import { OriginGroupError } from '../origin-group';

const DOMAIN_ID = 7;
const DOMAIN_NAME = 'example.com';
const ACCOUNT_ID = 3;
const EO_ZONE = 'zone-explicit-1';

const asMock = <T>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };

/** 按 X-TC-Action 分派假的 TEO 响应 */
function stubTeo(handlers: Record<string, unknown>) {
  requestJsonMock.mockImplementation(async (_url: string, options: { headers: Record<string, string> }) => {
    const action = options.headers['X-TC-Action'];
    if (!(action in handlers)) throw new Error('unexpected action: ' + action);
    const value = handlers[action];
    if (value instanceof Error) throw value;
    return value;
  });
}

function zoneList(zones: Array<{ ZoneId: string; ZoneName: string }>) {
  return { Response: { RequestId: 'r-zones', TotalCount: zones.length, Zones: zones } };
}

function groupList() {
  return {
    Response: {
      RequestId: 'r-groups',
      TotalCount: 1,
      OriginGroups: [
        {
          GroupId: 'og-1',
          Name: 'POOL',
          Type: 'HTTP',
          HostHeader: '',
          Records: [{ Record: '203.0.113.10', Type: 'IP_DOMAIN', Weight: 100, PrivateParameters: [] }],
          References: [
            { InstanceId: 'edge-1', InstanceName: 'www.example.com', InstanceType: 'acceleration-domain' },
          ],
        },
      ],
    },
  };
}

function stubDomain() {
  asMock(DomainOperations.getById).mockResolvedValue({
    id: DOMAIN_ID,
    name: DOMAIN_NAME,
    account_id: ACCOUNT_ID,
    // DNSPod 账号下这里存的是 DNSPod 域名 ID，与 EdgeOne 站点无关
    third_id: 'dnspod-domain-42',
  });
}

function stubDnspodAccount(config: Record<string, string> = { SecretId: 'id', SecretKey: 'key' }) {
  asMock(DnsProviderService.getAdapterByAccount).mockResolvedValue(
    new DnspodAdapter({ SecretId: 'id', SecretKey: 'key' }),
  );
  asMock(DnsAccountOperations.getById).mockResolvedValue({
    id: ACCOUNT_ID,
    type: 'dnspod',
    config: JSON.stringify(config),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requestJsonMock.mockReset();
  stubDomain();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EdgeOne 账号：直接复用账号配置', () => {
  it('用 third_id 作为 ZoneId，不额外调用 DescribeZones', async () => {
    asMock(DnsProviderService.getAdapterByAccount).mockResolvedValue(
      new TencenteoAdapter({ SecretId: 'id', SecretKey: 'key', site_type: 'mainland' }),
    );
    const ctx = await teoOpsForDomain(DOMAIN_ID);
    expect(ctx.credentialSource).toBe('tencenteo');
    expect(ctx.zoneId).toBe('dnspod-domain-42');
    expect(requestJsonMock).not.toHaveBeenCalled();
  });

  it('忽略 siteType / zoneId 参数，不需要额外声明', async () => {
    asMock(DnsProviderService.getAdapterByAccount).mockResolvedValue(
      new TencenteoAdapter({ SecretId: 'id', SecretKey: 'key', site_type: 'intl' }),
    );
    const ctx = await teoOpsForDomain(DOMAIN_ID, { siteType: 'mainland', zoneId: 'ignored' });
    expect(ctx.zoneId).toBe('dnspod-domain-42');
    expect(ctx.siteType).toBe('intl');
  });
});

describe('DNSPod 账号：用凭据直接发 EdgeOne 请求', () => {
  it('站点类型必须显式声明，缺省直接拒绝且不发请求', async () => {
    stubDnspodAccount();
    const error = await teoOpsForDomain(DOMAIN_ID, { zoneId: EO_ZONE }).catch((e) => e);
    expect(error.code).toBe('SITE_TYPE_REQUIRED');
    expect(error.message).toMatch(/mainland 或 intl/);
    expect(requestJsonMock).not.toHaveBeenCalled();
  });

  it('站点类型取值非法时拒绝', async () => {
    stubDnspodAccount();
    await expect(teoOpsForDomain(DOMAIN_ID, { siteType: 'global', zoneId: EO_ZONE })).rejects.toMatchObject({
      code: 'SITE_TYPE_INVALID',
    });
  });

  it('ZoneId 必须显式给出：DNSPod 域名与 EdgeOne 站点没有对应关系', async () => {
    stubDnspodAccount();
    const error = await teoOpsForDomain(DOMAIN_ID, { siteType: 'mainland' }).catch((e) => e);
    expect(error).toBeInstanceOf(OriginGroupError);
    expect(error.code).toBe('ZONE_ID_REQUIRED');
    expect(error.message).toMatch(/没有对应关系/);
    // 不再按域名反查，所以一个请求都不该发
    expect(requestJsonMock).not.toHaveBeenCalled();
  });

  it('给了 siteType + zoneId 后直接按该站点操作，不反查域名', async () => {
    stubDnspodAccount();
    stubTeo({ DescribeOriginGroup: groupList() });

    const ctx = await teoOpsForDomain(DOMAIN_ID, { siteType: 'mainland', zoneId: EO_ZONE });
    expect(ctx.credentialSource).toBe('dnspod');
    expect(ctx.zoneId).toBe(EO_ZONE);

    const groups = await ctx.ops.list({ limit: 100 });
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('POOL');
    // 只调了 DescribeOriginGroup，没有 DescribeZones
    const actions = requestJsonMock.mock.calls.map((call) => (call[1] as { headers: Record<string, string> }).headers['X-TC-Action']);
    expect(actions).toEqual(['DescribeOriginGroup']);
  });

  it('声明 intl 时打国际站域名，声明 mainland 时打国内站域名', async () => {
    for (const [siteType, expectedHost] of [
      ['intl', 'https://teo.intl.tencentcloudapi.com'],
      ['mainland', 'https://teo.tencentcloudapi.com'],
    ] as const) {
      requestJsonMock.mockReset();
      stubDnspodAccount();
      stubTeo({ DescribeOriginGroup: groupList() });

      const ctx = await teoOpsForDomain(DOMAIN_ID, { siteType, zoneId: EO_ZONE });
      expect(ctx.siteType).toBe(siteType);
      await ctx.ops.list({ limit: 100 });
      expect(requestJsonMock.mock.calls[0][0]).toBe(expectedHost);
    }
  });

  it('缺少密钥时报 CREDENTIAL_MISSING', async () => {
    stubDnspodAccount({ SecretId: 'id' });
    await expect(teoOpsForDomain(DOMAIN_ID, { siteType: 'mainland', zoneId: EO_ZONE })).rejects.toMatchObject({
      code: 'CREDENTIAL_MISSING',
    });
  });

  it('密钥没有 EdgeOne 权限时把底层错误透出', async () => {
    stubDnspodAccount();
    stubTeo({ DescribeOriginGroup: new Error('AuthFailure: 未授权') });
    const ctx = await teoOpsForDomain(DOMAIN_ID, { siteType: 'mainland', zoneId: EO_ZONE });
    await expect(ctx.ops.list({ limit: 100 })).rejects.toThrow(/AuthFailure/);
  });
});

describe('站点候选（edgeoneZones）', () => {
  it('用复用凭据列出可见站点，供用户显式选择', async () => {
    stubDnspodAccount();
    stubTeo({
      DescribeZones: zoneList([
        { ZoneId: 'zone-a', ZoneName: 'a.example.com' },
        { ZoneId: 'zone-b', ZoneName: 'b.example.com' },
      ]),
    });
    const zones = await listTeoZones(DOMAIN_ID, { siteType: 'mainland' });
    expect(zones).toEqual([
      { zoneId: 'zone-a', zoneName: 'a.example.com' },
      { zoneId: 'zone-b', zoneName: 'b.example.com' },
    ]);
  });

  it('列站点同样要求显式声明站点类型', async () => {
    stubDnspodAccount();
    await expect(listTeoZones(DOMAIN_ID)).rejects.toMatchObject({ code: 'SITE_TYPE_REQUIRED' });
  });
});

describe('其它情况', () => {
  it('既不是 EdgeOne 也不是 DNSPod 时报 PROVIDER_MISMATCH', async () => {
    asMock(DnsProviderService.getAdapterByAccount).mockResolvedValue({ check: async () => true });
    asMock(DnsAccountOperations.getById).mockResolvedValue({
      id: ACCOUNT_ID,
      type: 'cloudflare',
      config: JSON.stringify({ api_token: 'x' }),
    });
    await expect(teoOpsForDomain(DOMAIN_ID)).rejects.toMatchObject({ code: 'PROVIDER_MISMATCH' });
  });

  it('域名不存在时报 DOMAIN_NOT_FOUND', async () => {
    asMock(DomainOperations.getById).mockResolvedValue(undefined);
    await expect(teoOpsForDomain(DOMAIN_ID)).rejects.toMatchObject({ code: 'DOMAIN_NOT_FOUND' });
  });
});
