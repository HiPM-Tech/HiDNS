import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAllDomains: vi.fn(),
  updateExpiry: vi.fn(),
  connect: vi.fn(),
  submit: vi.fn(),
  checkWhoisForDomain: vi.fn(),
  checkAndSendNotification: vi.fn(),
  // 收件人口径走真实实现（realtime-audience），因此这里提供它依赖的底层操作
  getDomainById: vi.fn(),
  getAccountById: vi.fn(),
  hasRules: vi.fn(),
  getByDomainId: vi.fn(),
  getMembers: vi.fn(),
  getAllUsers: vi.fn(),
}));

vi.mock('../../lib/dns/providers', () => ({ dnsheWhoisScheduler: {} }));
vi.mock('../../db/bal/business-adapter', () => ({
  WhoisOperations: { getAllDomains: mocks.getAllDomains, updateExpiry: mocks.updateExpiry },
  DomainOperations: { getById: mocks.getDomainById },
  DnsAccountOperations: { getById: mocks.getAccountById },
  DomainPermissionOperations: {
    hasRules: mocks.hasRules,
    getByDomainId: mocks.getByDomainId,
  },
  TeamOperations: { getMembers: mocks.getMembers },
  UserOperations: { getAll: mocks.getAllUsers },
}));
vi.mock('../../db/dal/connection', () => ({ connect: mocks.connect }));
vi.mock('../taskManager', () => ({
  taskManager: { submit: (config: unknown, task: () => Promise<void>) => mocks.submit(config, task) },
}));
vi.mock('./checker', () => ({ checkWhoisForDomain: mocks.checkWhoisForDomain }));
vi.mock('./notifier', () => ({ checkAndSendNotification: mocks.checkAndSendNotification }));

import { wsService } from '../websocket';
import { resetRealtimeAudienceCache } from '../realtime-audience';
import { syncAllDomainsWhois } from './scheduler';

/** 取出「收件人 + 域名主键」便于断言 */
function pushedDomains(spy: { mock: { calls: unknown[][] } }): Array<{ audience: number[]; domainId: number }> {
  return spy.mock.calls.map((call) => ({
    audience: call[0] as number[],
    domainId: (call[1] as { data: { domainId: number } }).data.domainId,
  }));
}

beforeEach(() => {
  resetRealtimeAudienceCache();
  for (const fn of Object.values(mocks)) fn.mockReset();

  mocks.submit.mockImplementation(async (_config: unknown, task: () => Promise<void>) => task());
  mocks.updateExpiry.mockResolvedValue(undefined);
  mocks.checkAndSendNotification.mockResolvedValue(undefined);
  mocks.checkWhoisForDomain.mockResolvedValue({
    expiryDate: new Date('2027-01-01T00:00:00.000Z'),
    apexExpiryDate: null,
    status: 'active',
  });
  mocks.hasRules.mockResolvedValue(false);
  mocks.getByDomainId.mockResolvedValue([]);
  mocks.getMembers.mockResolvedValue([]);
  mocks.getAllUsers.mockResolvedValue([
    { id: 1, role_level: 3, status: 1 },
    { id: 100, role_level: 2, status: 1 },
    { id: 200, role_level: 2, status: 1 },
  ]);
  vi.spyOn(wsService, 'broadcastToUsers').mockImplementation(() => 1);
  vi.spyOn(wsService, 'broadcast').mockImplementation(() => undefined);
});

describe('WHOIS 同步的实时推送范围', () => {
  it('按域名可见用户定向推送，不再全局广播', async () => {
    mocks.getAllDomains.mockResolvedValue([{ id: 11, name: 'a.com', enabled: 1 }]);
    mocks.getDomainById.mockResolvedValue({ id: 11, account_id: 5 });
    mocks.getAccountById.mockResolvedValue({ id: 5, created_by: 100, enabled: 1 });

    await syncAllDomainsWhois();

    expect(pushedDomains(wsService.broadcastToUsers as never)).toEqual([
      { audience: [100, 1], domainId: 11 },
    ]);
    expect(wsService.broadcastToUsers).toHaveBeenCalledWith(
      [100, 1],
      expect.objectContaining({
        type: 'domain_whois_updated',
        data: expect.objectContaining({ domainId: 11, name: 'a.com', whoisStatus: 'active' }),
      }),
    );
    // 回归闸门：带域名与到期时间的 payload 不得再走全局广播
    expect(wsService.broadcast).not.toHaveBeenCalled();
  });

  it('多个域名各推给自己的可见用户集合（并发下不串号）', async () => {
    mocks.getAllDomains.mockResolvedValue([
      { id: 11, name: 'a.com', enabled: 1 },
      { id: 22, name: 'b.com', enabled: 1 },
    ]);
    mocks.getDomainById.mockImplementation(async (domainId: number) => ({ id: domainId, account_id: domainId }));
    mocks.getAccountById.mockImplementation(async (accountId: number) => ({
      id: accountId,
      created_by: accountId === 11 ? 100 : 200,
      enabled: 1,
    }));

    await syncAllDomainsWhois();

    const pushed = pushedDomains(wsService.broadcastToUsers as never).sort(
      (a, b) => a.domainId - b.domainId,
    );
    expect(pushed).toEqual([
      { audience: [100, 1], domainId: 11 },
      { audience: [200, 1], domainId: 22 },
    ]);
    expect(wsService.broadcast).not.toHaveBeenCalled();
  });

  it('团队授权成员同样收到（团队共享域名不得漏推）', async () => {
    mocks.getAllDomains.mockResolvedValue([{ id: 22, name: 'b.com', enabled: 1 }]);
    mocks.getDomainById.mockResolvedValue({ id: 22, account_id: 6 });
    mocks.getAccountById.mockResolvedValue({ id: 6, created_by: 200, enabled: 1 });
    mocks.hasRules.mockResolvedValue(true);
    mocks.getByDomainId.mockResolvedValue([{ user_id: null, team_id: 9 }]);
    mocks.getMembers.mockResolvedValue([{ user_id: 300 }, { user_id: 301 }]);

    await syncAllDomainsWhois();

    expect(pushedDomains(wsService.broadcastToUsers as never)).toEqual([
      { audience: [200, 300, 301, 1], domainId: 22 },
    ]);
  });

  it('账号被禁用的域名不推给任何人（超管也不推），同步本身照常完成', async () => {
    mocks.getAllDomains.mockResolvedValue([{ id: 33, name: 'c.com', enabled: 1 }]);
    mocks.getDomainById.mockResolvedValue({ id: 33, account_id: 8 });
    mocks.getAccountById.mockResolvedValue({ id: 8, created_by: 200, enabled: 0 });

    await syncAllDomainsWhois();

    expect(pushedDomains(wsService.broadcastToUsers as never)).toEqual([
      { audience: [], domainId: 33 },
    ]);
    expect(mocks.updateExpiry).toHaveBeenCalledTimes(1);
  });

  it('推送抛错不影响 WHOIS 落库与通知（旁路不得中断主流程）', async () => {
    mocks.getAllDomains.mockResolvedValue([{ id: 11, name: 'a.com', enabled: 1 }]);
    mocks.getDomainById.mockResolvedValue({ id: 11, account_id: 5 });
    mocks.getAccountById.mockResolvedValue({ id: 5, created_by: 100, enabled: 1 });
    vi.spyOn(wsService, 'broadcastToUsers').mockImplementation(() => {
      throw new Error('socket closed');
    });

    await syncAllDomainsWhois();

    expect(mocks.updateExpiry).toHaveBeenCalledTimes(1);
    expect(mocks.checkAndSendNotification).toHaveBeenCalledTimes(1);
  });
});
