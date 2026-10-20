import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { requestJsonMock } = vi.hoisted(() => ({ requestJsonMock: vi.fn() }));

vi.mock('../providers/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../providers/http')>();
  return { ...actual, requestJson: requestJsonMock };
});

vi.mock('../../../service/dns-provider-service', () => ({
  DnsProviderService: { getAdapterByAccount: vi.fn() },
}));

vi.mock('../../../db/bal/business-adapter', () => ({
  DomainOperations: { getById: vi.fn() },
  DnsAccountOperations: { getById: vi.fn() },
  TeamOperations: { isMember: vi.fn() },
}));

import { authorizeTencenteoOriginGroup, resetZoneAuthorizationCache } from '../origin-group-authorize';
import { TencenteoAdapter } from '../providers/tencenteo/adapter';
import { DnspodAdapter } from '../providers/dnspod/adapter';
import { DnsProviderService } from '../../../service/dns-provider-service';
import { DnsAccountOperations, DomainOperations, TeamOperations } from '../../../db/bal/business-adapter';

const DOMAIN_ID = 7;
const ACCOUNT_ID = 3;
const EO_ZONE = 'zone-owner-1';

const asMock = <T>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };

function principal(overrides: Partial<{ id: string; role: string }> = {}) {
  return { kind: 'user', id: '42', role: 'admin', ...overrides };
}

function stubTeoAccount(zoneId = EO_ZONE) {
  asMock(DnsProviderService.getAdapterByAccount).mockResolvedValue(
    new TencenteoAdapter({ SecretId: 'id', SecretKey: 'key', site_type: 'mainland' }),
  );
  asMock(DomainOperations.getById).mockResolvedValue({
    id: DOMAIN_ID,
    name: 'example.com',
    account_id: ACCOUNT_ID,
    third_id: zoneId,
  });
}

function stubDnspodAccount() {
  asMock(DnsProviderService.getAdapterByAccount).mockResolvedValue(
    new DnspodAdapter({ SecretId: 'id', SecretKey: 'key' }),
  );
  asMock(DomainOperations.getById).mockResolvedValue({
    id: DOMAIN_ID,
    name: 'example.com',
    account_id: ACCOUNT_ID,
    third_id: 'dnspod-domain-42',
  });
  asMock(DnsAccountOperations.getById).mockResolvedValue({
    id: ACCOUNT_ID,
    type: 'dnspod',
    created_by: 42,
    team_id: null,
    config: JSON.stringify({ SecretId: 'id', SecretKey: 'key' }),
  });
}

function stubZones(zones: Array<{ ZoneId: string; ZoneName: string }>) {
  requestJsonMock.mockResolvedValue({
    Response: { RequestId: 'r', TotalCount: zones.length, Zones: zones },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requestJsonMock.mockReset();
  resetZoneAuthorizationCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('身份与账号归属', () => {
  it('无法确定执行身份时拒绝', async () => {
    await expect(
      authorizeTencenteoOriginGroup(principal({ id: 'not-a-number' }), { domainId: DOMAIN_ID }, 'ext.read'),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('既非超管、也非账号所有者、也非团队成员时拒绝', async () => {
    stubTeoAccount();
    asMock(DnsAccountOperations.getById).mockResolvedValue({ id: ACCOUNT_ID, created_by: 999, team_id: null });
    await expect(
      authorizeTencenteoOriginGroup(principal(), { domainId: DOMAIN_ID }, 'ext.read'),
    ).rejects.toMatchObject({ code: 'ACCOUNT_FORBIDDEN' });
  });

  it('账号所有者放行', async () => {
    stubTeoAccount();
    asMock(DnsAccountOperations.getById).mockResolvedValue({ id: ACCOUNT_ID, created_by: 42, team_id: null });
    await expect(
      authorizeTencenteoOriginGroup(principal(), { domainId: DOMAIN_ID }, 'ext.read'),
    ).resolves.toBeUndefined();
  });

  it('账号所属团队成员放行', async () => {
    stubTeoAccount();
    asMock(DnsAccountOperations.getById).mockResolvedValue({ id: ACCOUNT_ID, created_by: 999, team_id: 5 });
    asMock(TeamOperations.isMember).mockResolvedValue(true);
    await expect(
      authorizeTencenteoOriginGroup(principal(), { domainId: DOMAIN_ID }, 'ext.read'),
    ).resolves.toBeUndefined();
    expect(TeamOperations.isMember).toHaveBeenCalledWith(5, 42);
  });

  it('团队成员关系不成立时拒绝', async () => {
    stubTeoAccount();
    asMock(DnsAccountOperations.getById).mockResolvedValue({ id: ACCOUNT_ID, created_by: 999, team_id: 5 });
    asMock(TeamOperations.isMember).mockResolvedValue(false);
    await expect(
      authorizeTencenteoOriginGroup(principal(), { domainId: DOMAIN_ID }, 'ext.read'),
    ).rejects.toMatchObject({ code: 'ACCOUNT_FORBIDDEN' });
  });

  it('超管跳过账号归属判定', async () => {
    stubTeoAccount();
    await expect(
      authorizeTencenteoOriginGroup(principal({ role: 'super_admin' }), { domainId: DOMAIN_ID }, 'ext.read'),
    ).resolves.toBeUndefined();
    expect(DnsAccountOperations.getById).not.toHaveBeenCalled();
  });
});

describe('站点归属（复用 DNSPod 凭据时必须核验）', () => {
  it('站点不在该凭据可见范围内时拒绝', async () => {
    stubDnspodAccount();
    stubZones([{ ZoneId: 'zone-other', ZoneName: 'other.com' }]);
    await expect(
      authorizeTencenteoOriginGroup(
        principal(),
        { domainId: DOMAIN_ID, siteType: 'mainland', zoneId: 'zone-wanted' },
        'ext.read',
      ),
    ).rejects.toMatchObject({ code: 'ZONE_FORBIDDEN' });
  });

  it('站点可见时放行，并缓存结果不再重复查询', async () => {
    stubDnspodAccount();
    stubZones([{ ZoneId: EO_ZONE, ZoneName: 'example.com' }]);

    const args = { domainId: DOMAIN_ID, siteType: 'mainland', zoneId: EO_ZONE };
    await expect(authorizeTencenteoOriginGroup(principal(), args, 'ext.read')).resolves.toBeUndefined();
    const callsAfterFirst = requestJsonMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await expect(authorizeTencenteoOriginGroup(principal(), args, 'ext.read')).resolves.toBeUndefined();
    expect(requestJsonMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('EdgeOne 账号无需核验站点（zoneId 本就取自该域名）', async () => {
    stubTeoAccount();
    asMock(DnsAccountOperations.getById).mockResolvedValue({ id: ACCOUNT_ID, created_by: 42, team_id: null });
    await expect(
      authorizeTencenteoOriginGroup(principal(), { domainId: DOMAIN_ID }, 'ext.read'),
    ).resolves.toBeUndefined();
    expect(requestJsonMock).not.toHaveBeenCalled();
  });
});

describe('读与写的准入必须分开（评审 P0）', () => {
  const args = { domainId: DOMAIN_ID };

  it('团队成员只能读：ext.write 必须拒绝', async () => {
    stubTeoAccount();
    asMock(DnsAccountOperations.getById).mockResolvedValue({ id: ACCOUNT_ID, created_by: 999, team_id: 5 });
    asMock(TeamOperations.isMember).mockResolvedValue(true);

    // 读放行
    await expect(authorizeTencenteoOriginGroup(principal(), args, 'ext.read')).resolves.toBeUndefined();
    // 写拒绝：否则被拉进团队的人可以整组覆盖该账号可见的所有站点
    await expect(authorizeTencenteoOriginGroup(principal(), args, 'ext.write')).rejects.toMatchObject({
      code: 'ACCOUNT_FORBIDDEN',
    });
  });

  it('创建者但不是 admin 只能读', async () => {
    stubTeoAccount();
    asMock(DnsAccountOperations.getById).mockResolvedValue({ id: ACCOUNT_ID, created_by: 42, team_id: null });

    await expect(authorizeTencenteoOriginGroup(principal(), args, 'ext.read')).resolves.toBeUndefined();
    await expect(
      authorizeTencenteoOriginGroup(principal({ role: 'user' }), args, 'ext.write'),
    ).rejects.toMatchObject({ code: 'ACCOUNT_FORBIDDEN' });
  });

  it('创建者且 admin 可以写', async () => {
    stubTeoAccount();
    asMock(DnsAccountOperations.getById).mockResolvedValue({ id: ACCOUNT_ID, created_by: 42, team_id: null });
    await expect(authorizeTencenteoOriginGroup(principal(), args, 'ext.write')).resolves.toBeUndefined();
  });

  it('超管可以写（不看账号归属）', async () => {
    stubTeoAccount();
    await expect(
      authorizeTencenteoOriginGroup(principal({ role: 'super_admin' }), args, 'ext.write'),
    ).resolves.toBeUndefined();
    expect(DnsAccountOperations.getById).not.toHaveBeenCalled();
  });

  it('非 user 身份给出独立错误码，而不是「身份缺失」', async () => {
    stubTeoAccount();
    await expect(
      authorizeTencenteoOriginGroup(
        { kind: 'token', id: 'token-1', role: 'admin' } as never,
        args,
        'ext.read',
      ),
    ).rejects.toMatchObject({ code: 'PRINCIPAL_KIND_UNSUPPORTED' });
  });
});
