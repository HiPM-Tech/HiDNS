import { describe, it, expect, vi, beforeEach } from 'vitest';

const ops = vi.hoisted(() => ({
  getDomainById: vi.fn(),
  getAccountById: vi.fn(),
  hasRules: vi.fn(),
  getByDomainId: vi.fn(),
  getMembers: vi.fn(),
  getAllUsers: vi.fn(),
}));

vi.mock('../db/bal/business-adapter', () => ({
  DomainOperations: { getById: ops.getDomainById },
  DnsAccountOperations: { getById: ops.getAccountById },
  DomainPermissionOperations: {
    hasRules: ops.hasRules,
    getByDomainId: ops.getByDomainId,
  },
  TeamOperations: { getMembers: ops.getMembers },
  UserOperations: { getAll: ops.getAllUsers },
}));

import {
  getDomainAudienceUserIds,
  getSuperAdminUserIds,
  resetRealtimeAudienceCache,
} from './realtime-audience';

const SUPER_ADMIN = { id: 1, role_level: 3, status: 1 };
const ADMIN_CREATOR = { id: 100, role_level: 2, status: 1 };

beforeEach(() => {
  resetRealtimeAudienceCache();
  for (const fn of Object.values(ops)) fn.mockReset();

  ops.getDomainById.mockResolvedValue({ id: 11, account_id: 5 });
  ops.getAccountById.mockResolvedValue({ id: 5, created_by: 100, enabled: 1 });
  ops.hasRules.mockResolvedValue(true);
  ops.getByDomainId.mockResolvedValue([]);
  ops.getMembers.mockResolvedValue([]);
  ops.getAllUsers.mockResolvedValue([SUPER_ADMIN, ADMIN_CREATOR]);
});

describe('域名实时推送收件人', () => {
  it('收件人 = 创建者(admin) + 直接授权 + 团队成员 + 超管，且去重', async () => {
    // 100 同时是创建者与直接授权用户：不得在结果里出现两次
    ops.getByDomainId.mockResolvedValue([
      { user_id: 100, team_id: null },
      { user_id: 101, team_id: null },
      { user_id: null, team_id: 7 },
    ]);
    ops.getMembers.mockResolvedValue([{ user_id: 200 }, { user_id: 201 }]);

    const audience = await getDomainAudienceUserIds(11);

    expect(audience.sort((a, b) => a - b)).toEqual([1, 100, 101, 200, 201]);
    expect(ops.getMembers).toHaveBeenCalledWith(7);
  });

  it('团队授权按团队成员展开：只记 team_id 会漏掉成员', async () => {
    ops.getDomainById.mockResolvedValue({ id: 12, account_id: 6 });
    ops.getAccountById.mockResolvedValue({ id: 6, created_by: 500, enabled: 1 });
    ops.getAllUsers.mockResolvedValue([SUPER_ADMIN, { id: 500, role_level: 2, status: 1 }]);
    ops.getByDomainId.mockResolvedValue([{ user_id: null, team_id: 9 }]);
    ops.getMembers.mockResolvedValue([{ user_id: 300 }, { user_id: 301 }, { user_id: 302 }]);

    const audience = await getDomainAudienceUserIds(12);

    expect(audience.sort((a, b) => a - b)).toEqual([1, 300, 301, 302, 500]);
  });

  it('与该域名无关的用户不会进入收件人集合', async () => {
    ops.getByDomainId.mockResolvedValue([{ user_id: 101, team_id: null }]);

    const audience = await getDomainAudienceUserIds(11);

    expect(audience).not.toContain(999);
    expect(audience.sort((a, b) => a - b)).toEqual([1, 100, 101]);
  });

  it('账号已禁用 → 全员不可读（超管也不推）', async () => {
    ops.getAccountById.mockResolvedValue({ id: 5, created_by: 100, enabled: 0 });

    await expect(getDomainAudienceUserIds(11)).resolves.toEqual([]);
  });

  it('账号不存在 → 全员不可读', async () => {
    ops.getAccountById.mockResolvedValue(undefined);

    await expect(getDomainAudienceUserIds(11)).resolves.toEqual([]);
  });

  it('域名不存在或缺少账号 → 空集合', async () => {
    ops.getDomainById.mockResolvedValue(undefined);
    await expect(getDomainAudienceUserIds(11)).resolves.toEqual([]);

    ops.getDomainById.mockResolvedValue({ id: 12 });
    await expect(getDomainAudienceUserIds(12)).resolves.toEqual([]);
  });

  it('创建者不是 admin 时不进入集合（与 HTTP 层 createdBy && role >= admin 一致）', async () => {
    ops.getAllUsers.mockResolvedValue([SUPER_ADMIN]);

    const audience = await getDomainAudienceUserIds(11);

    expect(audience).toEqual([1]);
  });

  it('hasRules 为假时忽略残留授权行，只留创建者与超管', async () => {
    ops.hasRules.mockResolvedValue(false);
    ops.getByDomainId.mockResolvedValue([{ user_id: 101, team_id: 7 }]);
    ops.getMembers.mockResolvedValue([{ user_id: 200 }]);

    const audience = await getDomainAudienceUserIds(11);

    expect(audience.sort((a, b) => a - b)).toEqual([1, 100]);
    expect(ops.getMembers).not.toHaveBeenCalled();
  });

  it('查询失败返回空集合（fail-closed，不得退化为全局广播）', async () => {
    ops.getDomainById.mockRejectedValue(new Error('db down'));

    await expect(getDomainAudienceUserIds(14)).resolves.toEqual([]);
  });

  it('非法 domainId 不查库', async () => {
    await expect(getDomainAudienceUserIds(0)).resolves.toEqual([]);
    await expect(getDomainAudienceUserIds(Number.NaN)).resolves.toEqual([]);
    expect(ops.getDomainById).not.toHaveBeenCalled();
  });
});

describe('特权用户名单', () => {
  it('只取未停用的账号，超管同时计入 admin', async () => {
    ops.getAllUsers.mockResolvedValue([
      { id: 1, role_level: 3, status: 1 },
      { id: 2, role_level: 3, status: 0 },
      { id: 3, role_level: 2, status: 1 },
      { id: 4, role_level: 1, status: 1 },
    ]);

    await expect(getSuperAdminUserIds()).resolves.toEqual([1]);
  });

  it('60s 内命中缓存：WHOIS 批量同步不得逐域名扫用户表', async () => {
    await getSuperAdminUserIds();
    await getSuperAdminUserIds();

    expect(ops.getAllUsers).toHaveBeenCalledTimes(1);
  });

  it('用户表查询失败 → 空名单（不额外放行任何人）', async () => {
    ops.getAllUsers.mockRejectedValue(new Error('db down'));

    await expect(getSuperAdminUserIds()).resolves.toEqual([]);
  });
});
