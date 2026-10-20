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

import { teoOpsForDomain } from '../teo-ops';
import { TencenteoAdapter } from '../adapter';
import { DnspodAdapter } from '../../dnspod/adapter';
import { DnsProviderService } from '../../../../../service/dns-provider-service';
import { DnsAccountOperations, DomainOperations } from '../../../../../db/bal/business-adapter';
import { OriginGroupError } from '../origin-group';

const DOMAIN_ID = 7;
const DOMAIN_NAME = 'example.com';
const ACCOUNT_ID = 3;

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

function stubDomain(accountId = ACCOUNT_ID) {
  asMock(DomainOperations.getById).mockResolvedValue({
    id: DOMAIN_ID,
    name: DOMAIN_NAME,
    account_id: accountId,
    // DNSPod 账号下这里存的是 DNSPod 域名 ID，不是 EO 的 ZoneId
    third_id: 'dnspod-domain-42',
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

describe('EdgeOne 账号：直接用 third_id', () => {
  it('走原生路径，不查 DescribeZones', async () => {
    asMock(DnsProviderService.getAdapterByAccount).mockResolvedValue(
      new TencenteoAdapter({ SecretId: 'id', SecretKey: 'key' }),
    );
    const ctx = await teoOpsForDomain(DOMAIN_ID);
    expect(ctx.credentialSource).toBe('tencenteo');
    expect(ctx.zoneId).toBe('dnspod-domain-42');
    expect(requestJsonMock).not.toHaveBeenCalled();
  });
});

describe('DNSPod 账号：复用同一对腾讯云密钥调用 EdgeOne', () => {
  function stubDnspodAccount(
    config: Record<string, string> = { SecretId: 'id', SecretKey: 'key', site_type: 'mainland' },
  ) {
    asMock(DnsProviderService.getAdapterByAccount).mockResolvedValue(
      new DnspodAdapter({ SecretId: 'id', SecretKey: 'key' }),
    );
    asMock(DnsAccountOperations.getById).mockResolvedValue({
      id: ACCOUNT_ID,
      type: 'dnspod',
      config: JSON.stringify(config),
    });
  }

  it('按域名反查 ZoneId，并标记凭据来源', async () => {
    stubDnspodAccount();
    stubTeo({
      DescribeZones: zoneList([
        { ZoneId: 'zone-other', ZoneName: 'other.com' },
        { ZoneId: 'zone-target', ZoneName: DOMAIN_NAME },
      ]),
    });

    const ctx = await teoOpsForDomain(DOMAIN_ID);
    expect(ctx.credentialSource).toBe('dnspod');
    expect(ctx.zoneId).toBe('zone-target');
  });

  it('反查到 ZoneId 后可以直接列出源站组', async () => {
    stubDnspodAccount();
    stubTeo({
      DescribeZones: zoneList([{ ZoneId: 'zone-target', ZoneName: DOMAIN_NAME }]),
      DescribeOriginGroup: groupList(),
    });

    const ctx = await teoOpsForDomain(DOMAIN_ID);
    const groups = await ctx.ops.list({ limit: 100 });
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('POOL');
    expect(groups[0].records[0].record).toBe('203.0.113.10');
  });

  it('站点类型必须显式声明：缺省直接拒绝，不猜 mainland', async () => {
    stubDnspodAccount({ SecretId: 'id', SecretKey: 'key' });
    stubTeo({ DescribeZones: zoneList([{ ZoneId: 'zone-target', ZoneName: DOMAIN_NAME }]) });

    const error = await teoOpsForDomain(DOMAIN_ID).catch((e) => e);
    expect(error.code).toBe('SITE_TYPE_REQUIRED');
    expect(error.message).toMatch(/mainland 或 intl/);
    // 没有声明就不该发出任何请求
    expect(requestJsonMock).not.toHaveBeenCalled();
  });

  it('站点类型取值非法时拒绝', async () => {
    stubDnspodAccount({ SecretId: 'id', SecretKey: 'key', site_type: 'global' });
    await expect(teoOpsForDomain(DOMAIN_ID)).rejects.toMatchObject({ code: 'SITE_TYPE_INVALID' });
  });

  it('声明 intl 时打国际站域名，声明 mainland 时打国内站域名', async () => {
    for (const [siteType, expectedHost] of [
      ['intl', 'https://teo.intl.tencentcloudapi.com'],
      ['mainland', 'https://teo.tencentcloudapi.com'],
    ] as const) {
      requestJsonMock.mockReset();
      stubDnspodAccount({ SecretId: 'id', SecretKey: 'key', site_type: siteType });
      stubTeo({ DescribeZones: zoneList([{ ZoneId: 'zone-target', ZoneName: DOMAIN_NAME }]) });

      const ctx = await teoOpsForDomain(DOMAIN_ID);
      expect(ctx.siteType).toBe(siteType);
      expect(requestJsonMock.mock.calls[0][0]).toBe(expectedHost);
    }
  });

  it('域名匹配是精确等值，不会被前缀域名命中', async () => {
    stubDnspodAccount();
    stubTeo({
      DescribeZones: zoneList([
        { ZoneId: 'zone-sub', ZoneName: 'a.example.com' },
        { ZoneId: 'zone-root', ZoneName: 'example.com' },
      ]),
    });
    const ctx = await teoOpsForDomain(DOMAIN_ID);
    expect(ctx.zoneId).toBe('zone-root');
  });

  it('域名未接入 EdgeOne 时报 ZONE_NOT_FOUND', async () => {
    stubDnspodAccount();
    stubTeo({ DescribeZones: zoneList([{ ZoneId: 'zone-other', ZoneName: 'other.com' }]) });
    await expect(teoOpsForDomain(DOMAIN_ID)).rejects.toMatchObject({ code: 'ZONE_NOT_FOUND' });
  });

  it('缺少密钥时报 CREDENTIAL_MISSING', async () => {
    asMock(DnsProviderService.getAdapterByAccount).mockResolvedValue(
      new DnspodAdapter({ SecretId: 'id', SecretKey: 'key' }),
    );
    asMock(DnsAccountOperations.getById).mockResolvedValue({
      id: ACCOUNT_ID,
      type: 'dnspod',
      config: JSON.stringify({ SecretId: 'id' }),
    });
    await expect(teoOpsForDomain(DOMAIN_ID)).rejects.toMatchObject({ code: 'CREDENTIAL_MISSING' });
  });

  it('密钥没有 EdgeOne 权限时翻译成可读错误', async () => {
    stubDnspodAccount();
    stubTeo({ DescribeZones: new Error('AuthFailure: 未授权') });
    const error = await teoOpsForDomain(DOMAIN_ID).catch((e) => e);
    expect(error).toBeInstanceOf(OriginGroupError);
    expect(error.code).toBe('EDGEONE_ACCESS_DENIED');
    expect(error.message).toMatch(/EdgeOne 权限/);
  });
});

describe('其它提供商', () => {
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
