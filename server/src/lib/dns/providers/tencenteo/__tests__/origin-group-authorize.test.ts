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
  TeamOperations: { isMember: vi.fn() },
}));

import { authorizeTencenteoOriginGroup, resetZoneAuthorizationCache } from '../origin-group-authorize';
import { TencenteoAdapter } from '../adapter';
import { DnspodAdapter } from '../../dnspod/adapter';
import { DnsProviderService } from '../../../../../service/dns-provider-service';
import { DnsAccountOperations, DomainOperations, TeamOperations } from '../../../../../db/bal/business-adapter';

const DOMAIN_ID = 7;
const ACCOUNT_ID = 3;
const EO_ZONE = 'zone-owner-1';

/** 新契约：账号 + 作用域 */
const NEW_ARGS = { accountId: ACCOUNT_ID, scopeId: EO_ZONE };
/** 旧形态：只有域名（存量工作流的形态） */
const LEGACY_ARGS = { domainId: DOMAIN_ID };

const asMock = <T>(fn: T) => fn as unknown as { mockResolvedValue: (v: unknown) => void };

function principal(overrides: Partial<{ id: string; role: string }> = {}) {
  return { kind: 'user', id: '42', role: 'admin', ...overrides };
}

function stubZones(zones: Array<{ ZoneId: string; ZoneName: string }>) {
  requestJsonMock.mockResolvedValue({
    Response: { RequestId: 'r', TotalCount: zones.length, Zones: zones },
  });
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
  // 账号优先后 EdgeOne 账号也要核验作用域归属，listZones 会被调用
  stubZones([{ ZoneId: zoneId, ZoneName: 'example.com' }]);
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

beforeEach(() => {
  vi.clearAllMocks();
  requestJsonMock.mockReset();
  resetZoneAuthorizationCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('定位分支（设计 §2.5）', () => {
  it('accountId 与 domainId 并存 → AMBIGUOUS_LOCATION，不静默选一个', async () => {
    await expect(
      authorizeTencenteoOriginGroup(principal(), { ...NEW_ARGS, domainId: DOMAIN_ID }, 'ext.read'),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS_LOCATION' });
  });

  it('两者都缺 → INVALID_ARGS', async () => {
    await expect(authorizeTencenteoOriginGroup(principal(), {}, 'ext.read')).rejects.toMatchObject({
      code: 'INVALID_ARGS',
    });
  });

  it('accountId 非正整数 → INVALID_ARGS（不是 NOT_FOUND）', async () => {
    await expect(
      authorizeTencenteoOriginGroup(principal(), { accountId: 'abc', scopeId: EO_ZONE }, 'ext.read'),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });
});

describe('身份与账号归属', () => {
  it('无法确定执行身份时拒绝', async () => {
    await expect(
      authorizeTencenteoOriginGroup(principal({ id: 'not-a-number' }), NEW_ARGS, 'ext.read'),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('既非超管、也非账号所有者、也非团队成员时拒绝，且不触达适配器', async () => {
    asMock(DnsAccountOperations.getById).mockResolvedValue({ id: ACCOUNT_ID, created_by: 999, team_id: null });
    await expect(authorizeTencenteoOriginGroup(principal(), NEW_ARGS, 'ext.read')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // 锁住「先鉴权、再解析」：判权失败时不得去构造适配器（那会读凭据/打上游）
    expect(DnsProviderService.getAdapterByAccount).not.toHaveBeenCalled();
  });

  it('账号被停用时拒绝（超管也不例外），且不触达适配器', async () => {
    asMock(DnsAccountOperations.getById).mockResolvedValue({
      id: ACCOUNT_ID,
      created_by: 42,
      team_id: null,
      enabled: 0,
    });
    await expect(
      authorizeTencenteoOriginGroup(principal({ role: 'super_admin' }), NEW_ARGS, 'ext.read'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(DnsProviderService.getAdapterByAccount).not.toHaveBeenCalled();
  });

  it('旧形态下域名不存在 → NOT_FOUND，且不触达适配器', async () => {
    asMock(DomainOperations.getById).mockResolvedValue(undefined);
    await expect(
      authorizeTencenteoOriginGroup(principal(), LEGACY_ARGS, 'ext.read'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(DnsProviderService.getAdapterByAccount).not.toHaveBeenCalled();
  });

  it('账号所有者放行', async () => {
    stubTeoAccount();
    asMock(DnsAccountOperations.getById).mockResolvedValue({ id: ACCOUNT_ID, created_by: 42, team_id: null });
    await expect(authorizeTencenteoOriginGroup(principal(), NEW_ARGS, 'ext.read')).resolves.toBeUndefined();
  });

  it('账号所属团队成员放行', async () => {
    stubTeoAccount();
    asMock(DnsAccountOperations.getById).mockResolvedValue({ id: ACCOUNT_ID, created_by: 999, team_id: 5 });
    asMock(TeamOperations.isMember).mockResolvedValue(true);
    await expect(authorizeTencenteoOriginGroup(principal(), NEW_ARGS, 'ext.read')).resolves.toBeUndefined();
    expect(TeamOperations.isMember).toHaveBeenCalledWith(5, 42);
  });

  it('团队成员关系不成立时拒绝', async () => {
    asMock(DnsAccountOperations.getById).mockResolvedValue({ id: ACCOUNT_ID, created_by: 999, team_id: 5 });
    asMock(TeamOperations.isMember).mockResolvedValue(false);
    await expect(authorizeTencenteoOriginGroup(principal(), NEW_ARGS, 'ext.read')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('超管放行，但仍要读账号行确认账号存在且未停用', async () => {
    stubTeoAccount();
    asMock(DnsAccountOperations.getById).mockResolvedValue({ id: ACCOUNT_ID, created_by: 999, team_id: null });
    await expect(
      authorizeTencenteoOriginGroup(principal({ role: 'super_admin' }), NEW_ARGS, 'ext.read'),
    ).resolves.toBeUndefined();
    expect(DnsAccountOperations.getById).toHaveBeenCalledTimes(1);
    expect(TeamOperations.isMember).not.toHaveBeenCalled();
  });
});

describe('作用域归属：两条凭据路径都要核验（设计 §2.6）', () => {
  it('EdgeOne 账号：作用域不属于该账号 → NOT_FOUND（不再无条件放行）', async () => {
    asMock(DnsAccountOperations.getById).mockResolvedValue({ id: ACCOUNT_ID, created_by: 42, team_id: null });
    asMock(DnsProviderService.getAdapterByAccount).mockResolvedValue(
      new TencenteoAdapter({ SecretId: 'id', SecretKey: 'key', site_type: 'mainland' }),
    );
    stubZones([{ ZoneId: 'zone-visible', ZoneName: 'visible.com' }]);
    await expect(
      authorizeTencenteoOriginGroup(principal(), { accountId: ACCOUNT_ID, scopeId: 'zone-other' }, 'ext.read'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('复用 DNSPod 凭据：作用域可见时放行并缓存', async () => {
    stubDnspodAccount();
    stubZones([{ ZoneId: EO_ZONE, ZoneName: 'example.com' }]);
    // 用旧形态验证缓存：账号路径的作用域校验在解析层完成（每次都会 listZones），不走这条缓存
    const args = { domainId: DOMAIN_ID, siteType: 'mainland', zoneId: EO_ZONE };
    await expect(authorizeTencenteoOriginGroup(principal(), args, 'ext.read')).resolves.toBeUndefined();
    const callsAfterFirst = requestJsonMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    await expect(authorizeTencenteoOriginGroup(principal(), args, 'ext.read')).resolves.toBeUndefined();
    expect(requestJsonMock.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('新旧形态与读写的准入', () => {
  it('存量只读不中断：只有 domainId 的 ext.read 仍放行', async () => {
    stubTeoAccount();
    asMock(DnsAccountOperations.getById).mockResolvedValue({ id: ACCOUNT_ID, created_by: 42, team_id: null });
    await expect(authorizeTencenteoOriginGroup(principal(), LEGACY_ARGS, 'ext.read')).resolves.toBeUndefined();
  });

  it('写类旧形态拒绝，且早于任何凭据解析', async () => {
    asMock(DnsAccountOperations.getById).mockResolvedValue({ id: ACCOUNT_ID, created_by: 42, team_id: null });
    await expect(
      authorizeTencenteoOriginGroup(principal({ role: 'super_admin' }), LEGACY_ARGS, 'ext.write'),
    ).rejects.toMatchObject({ code: 'LEGACY_WRITE_REJECTED' });
    // 不可逆的写入不允许走旧形态；同时不得先解析凭据（否则错误串会变成枚举器）
    expect(DnsProviderService.getAdapterByAccount).not.toHaveBeenCalled();
  });

  it('团队成员只能读：ext.write 必须拒绝', async () => {
    stubTeoAccount();
    asMock(DnsAccountOperations.getById).mockResolvedValue({ id: ACCOUNT_ID, created_by: 999, team_id: 5 });
    asMock(TeamOperations.isMember).mockResolvedValue(true);
    await expect(authorizeTencenteoOriginGroup(principal(), NEW_ARGS, 'ext.write')).rejects.toMatchObject({
      code: 'WRITE_FORBIDDEN',
    });
  });

  it('创建者但不是 admin 只能读', async () => {
    stubTeoAccount();
    asMock(DnsAccountOperations.getById).mockResolvedValue({ id: ACCOUNT_ID, created_by: 42, team_id: null });
    await expect(
      authorizeTencenteoOriginGroup(principal({ role: 'user' }), NEW_ARGS, 'ext.write'),
    ).rejects.toMatchObject({ code: 'WRITE_FORBIDDEN' });
  });

  it('创建者且 admin 可以写', async () => {
    stubTeoAccount();
    asMock(DnsAccountOperations.getById).mockResolvedValue({ id: ACCOUNT_ID, created_by: 42, team_id: null });
    await expect(authorizeTencenteoOriginGroup(principal(), NEW_ARGS, 'ext.write')).resolves.toBeUndefined();
  });

  it('超管可以写（但要求账号存在且未停用）', async () => {
    stubTeoAccount();
    asMock(DnsAccountOperations.getById).mockResolvedValue({ id: ACCOUNT_ID, created_by: 999, team_id: null });
    await expect(
      authorizeTencenteoOriginGroup(principal({ role: 'super_admin' }), NEW_ARGS, 'ext.write'),
    ).resolves.toBeUndefined();
  });

  it('非 user 身份给出独立错误码，而不是「身份缺失」', async () => {
    await expect(
      authorizeTencenteoOriginGroup({ kind: 'token', id: '1', role: 'admin' }, NEW_ARGS, 'ext.read'),
    ).rejects.toMatchObject({ code: 'PRINCIPAL_KIND_UNSUPPORTED' });
  });
});
