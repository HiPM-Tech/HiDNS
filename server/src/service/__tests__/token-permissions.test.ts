import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenPayload } from '../../types/token';

vi.mock('../../db/bal/business-adapter', () => ({
  TokenOperations: {
    getByTokenHash: vi.fn(), updateLastUsed: vi.fn(), getByUserId: vi.fn(),
    getServicePermissionBatch: vi.fn(), updateByUser: vi.fn(), create: vi.fn(),
  },
  DomainOperations: { checkUserDomainAccess: vi.fn() },
}));

import { TokenOperations } from '../../db/bal/business-adapter';
import { createUserToken, getUserTokens, hasDnsPermission, hasServicePermission, updateTokenPermissions, verifyToken } from '../token';
import { readAllowedServices } from '../token-permissions';
import { migrateTokenServicePermissions } from '../token-migration';

const payload: TokenPayload = {
  type: 'token', tokenId: 1, userId: 2, maxRole: 3, allowedDomains: [11],
  allowedServices: { dns: ['records.read'] },
};

beforeEach(() => vi.resetAllMocks());

describe('token permissions', () => {
  it('读权限不允许写入、其他资源、MCP；管理员角色也不能绕过令牌权限', () => {
    expect(hasServicePermission(payload, 'dns')).toBe(true);
    expect(hasDnsPermission(payload, 'records.read')).toBe(true);
    expect(hasDnsPermission(payload, 'records.write')).toBe(false);
    expect(hasDnsPermission(payload, 'domains.read')).toBe(false);
    expect(hasServicePermission(payload, 'mcp')).toBe(false);
    expect(hasDnsPermission({ ...payload, allowedServices: { dns: ['records.write'] } }, 'records.read')).toBe(false);
  });

  it('空配置拒绝权限，通配只对当前服务有效', () => {
    expect(hasServicePermission({ ...payload, allowedServices: { dns: [] } }, 'dns')).toBe(false);
    expect(hasDnsPermission({ ...payload, allowedServices: {} }, 'records.read')).toBe(false);
    const wildcard: TokenPayload = { ...payload, allowedServices: { dns: ['*'] } };
    expect(hasDnsPermission(wildcard, 'records.write')).toBe(true);
    expect(hasServicePermission(wildcard, 'mcp')).toBe(false);
    expect(hasServicePermission(wildcard, 'future-service')).toBe(false);
  });

  it.each([
    { old: ['dns'], expected: { dns: ['*'] } },
    { old: ['mcp'], expected: { mcp: ['*'] } },
    { old: ['dns', 'mcp'], expected: { dns: ['*'], mcp: ['*'] } },
    { old: ['*'], expected: { dns: ['*'], mcp: ['*'] } },
    { old: [], expected: {} },
    { old: ['records.write', 'unknown'], expected: {} },
  ])('历史配置只迁移既有服务：$old', ({ old, expected }) => {
    expect(readAllowedServices(old)).toEqual(expected);
    expect(readAllowedServices(JSON.stringify(old))).toEqual(expected);
  });

  it('签发、列出与验证均使用对象权限', async () => {
    vi.mocked(TokenOperations.create).mockResolvedValue(1);
    const services = { dns: ['records.read' as const], mcp: ['*' as const] };
    const created = await createUserToken(2, { name: 'read', allowed_domains: [11], allowed_services: services, max_role: 1 });
    expect(created.tokenData.allowed_services).toEqual(services);
    expect(TokenOperations.create).toHaveBeenCalledWith(expect.objectContaining({ allowed_services: JSON.stringify(services) }));
    const row = { id: 1, user_id: 2, name: 'read', is_active: 1, max_role: 1,
      allowed_domains: '[11]', allowed_services: JSON.stringify(services) };
    vi.mocked(TokenOperations.getByTokenHash).mockResolvedValue(row);
    vi.mocked(TokenOperations.getByUserId).mockResolvedValue([row]);
    expect((await verifyToken(created.token))?.allowedServices).toEqual(services);
    expect((await getUserTokens(2))[0].allowed_services).toEqual(services);
  });

  it('验证兼容旧数组，但损坏配置和未知权限 fail closed', async () => {
    for (const value of ['["dns"]', '{bad-json', '{"dns":["records.typo"]}', 'null']) {
      vi.mocked(TokenOperations.getByTokenHash).mockResolvedValue({
        id: 1, user_id: 2, is_active: 1, max_role: 3, allowed_domains: '[]', allowed_services: value,
      });
      const verified = await verifyToken('hidns_test');
      if (value === '["dns"]') expect(verified?.allowedServices).toEqual({ dns: ['*'] });
      else expect(verified).toBeNull();
    }
  });

  it('仅更新权限不清除有效期；无效权限不会写入数据库', async () => {
    await updateTokenPermissions(1, 2, { allowed_services: { dns: ['records.read'] } });
    expect(TokenOperations.updateByUser).toHaveBeenCalledWith(1, 2, expect.objectContaining({
      allowed_services: '{"dns":["records.read"]}', start_time: undefined, end_time: undefined,
    }));
    vi.mocked(TokenOperations.updateByUser).mockClear();
    await expect(updateTokenPermissions(1, 2, {
      allowed_services: { dns: ['records.typo'] } as never,
    })).rejects.toThrow('Invalid permissions');
    expect(TokenOperations.updateByUser).not.toHaveBeenCalled();
    await updateTokenPermissions(1, 2, { end_time: null });
    expect(TokenOperations.updateByUser).toHaveBeenCalledWith(1, 2, expect.objectContaining({ end_time: null }));
  });

  it('启动迁移包含分页与停用令牌，保留新对象并可重复执行', async () => {
    vi.mocked(TokenOperations.getServicePermissionBatch)
      .mockResolvedValueOnce([
        { id: 1, user_id: 2, allowed_services: '["mcp"]' },
        { id: 2, user_id: 2, allowed_services: { dns: ['records.read'] } },
        { id: 3, user_id: 2, allowed_services: '{bad-json' },
      ])
      .mockResolvedValueOnce([{ id: 4, user_id: 5, allowed_services: ['*'] }])
      .mockResolvedValue([]);
    await migrateTokenServicePermissions();
    expect(TokenOperations.updateByUser).toHaveBeenCalledTimes(2);
    expect(TokenOperations.updateByUser).toHaveBeenCalledWith(1, 2, { allowed_services: '{"mcp":["*"]}' });
    expect(TokenOperations.updateByUser).toHaveBeenCalledWith(4, 5, { allowed_services: '{"dns":["*"],"mcp":["*"]}' });
    expect(TokenOperations.getServicePermissionBatch).toHaveBeenNthCalledWith(2, 3);
    expect(TokenOperations.getServicePermissionBatch).toHaveBeenNthCalledWith(3, 4);
    await migrateTokenServicePermissions();
    expect(TokenOperations.updateByUser).toHaveBeenCalledTimes(2);
  });
});
