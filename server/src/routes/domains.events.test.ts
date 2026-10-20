import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http, { Server } from 'http';
import { AddressInfo } from 'net';

/**
 * 回归目标：域名类事件不得再走全局广播。
 *
 * 现象：创建/更新/删除/续期四处都用 wsService.broadcast 推送 domain_* 事件，
 * payload 里带域名、备注、启用状态与到期时间；任何在线客户端都能收到他人域名的
 * 元信息与到期时间，等于跨用户外泄。
 *
 * 口径依据（本文件的 HTTP 读接口）：
 *   - GET /domains/:id      → getDomainAccess(...).canRead（= resolveDomainAccess）
 *   - GET /renewable-domains→ 仅 role >= ROLE_ADMIN，且不按归属过滤
 * 因此前三个事件按 getDomainAudienceUserIds(domainId) 投递，续期事件推给全部管理员。
 */
const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  broadcastToUsers: vi.fn(),
  user: { userId: 100, role: 2 },
  deleted: false,
  domains: new Map<number, Record<string, unknown>>(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = mocks.user;
    next();
  },
  requireDomainPermission: () => (_req: any, _res: any, next: any) => next(),
  requireTokenDomainPermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../db/bal/business-adapter', () => ({
  DomainOperations: {
    // 删除后 getById 查不到，用来验证收件人确实是「删之前」算出来的
    getById: vi.fn(async (id: number) => (mocks.deleted ? undefined : mocks.domains.get(id))),
    getByAccountIdAndName: vi.fn(async () => undefined),
    create: vi.fn(async () => 12),
    updateThirdIdAndRecordCount: vi.fn(async () => undefined),
    updateRemarkAndHidden: vi.fn(async () => undefined),
    setEnabled: vi.fn(async () => undefined),
    delete: vi.fn(async () => {
      mocks.deleted = true;
    }),
    getAll: vi.fn(async () => []),
    updateRecordCount: vi.fn(async () => undefined),
  },
  DnsAccountOperations: {
    getById: vi.fn(async () => ({ id: 5, type: 'cloudflare', config: '{}', created_by: 100, enabled: 1 })),
    getCreatedBy: vi.fn(async () => 100),
  },
  DomainPermissionOperations: {
    hasRules: vi.fn(async () => false),
    getByDomainId: vi.fn(async () => []),
    getByDomainAndUser: vi.fn(async () => []),
    getByDomainAndTeamMember: vi.fn(async () => []),
  },
  TeamOperations: { getMembers: vi.fn(async () => []), isMember: vi.fn(async () => false) },
  UserOperations: {
    getAll: vi.fn(async () => [
      { id: 1, role_level: 3, status: 1 },
      { id: 100, role_level: 2, status: 1 },
      { id: 200, role_level: 2, status: 1 },
      { id: 300, role_level: 1, status: 1 },
    ]),
  },
  RenewableDomainOperations: {
    getById: vi.fn(async () => ({ id: 3, account_id: 5, full_domain: 'r.com', enabled: 1, third_id: null })),
    updateExpiresAt: vi.fn(async () => undefined),
  },
  UserPreferencesOperations: {},
  NSMonitorOperations: { getUserMonitors: vi.fn(async () => []), delete: vi.fn(async () => undefined) },
  SystemCacheOperations: {},
  WhoisOperations: {},
}));
vi.mock('../service/renewalScheduler', () => ({
  renewalRegistry: {
    getScheduler: () => ({ renewDomain: async () => ({ success: true, new_expires_at: '2028-01-01 00:00:00' }) }),
  },
}));
vi.mock('../lib/dns/DnsHelper', () => ({ createAdapter: () => ({}) }));
vi.mock('../lib/dns/providers', () => ({ dnsheGetWhois: vi.fn() }));
vi.mock('../lib/dns/providers/registry', () => ({ providerDefinitionMap: new Map() }));
vi.mock('../lib/domain-event-bus', () => ({ publishDomainEvent: vi.fn() }));
vi.mock('../service/audit', () => ({ logAuditOperation: vi.fn(async () => undefined) }));
vi.mock('../service/whois', () => ({
  syncDomainWhois: vi.fn(async () => undefined),
  getRootDomain: vi.fn(() => 'a.com'),
  queryWhois: vi.fn(async () => null),
  groupDomains: vi.fn(() => []),
}));
vi.mock('../service/groupedCacheJob', () => ({
  getCachedGroupedData: vi.fn(async () => null),
  setCachedGroupedData: vi.fn(async () => undefined),
  getCacheVersion: vi.fn(async () => 1),
  bumpCacheVersion: vi.fn(async () => undefined),
  submitGroupedCacheUpdate: vi.fn(async () => undefined),
}));
vi.mock('../service/websocket', () => ({
  wsService: { broadcast: mocks.broadcast, broadcastToUsers: mocks.broadcastToUsers },
}));

import domainsRouter from './domains';
import { resetRealtimeAudienceCache } from '../service/realtime-audience';

let server: Server;

function audiences(): number[][] {
  return mocks.broadcastToUsers.mock.calls.map((call) =>
    [...(call[0] as number[])].sort((a, b) => a - b),
  );
}

function url(path: string): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(url(path), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/domains', domainsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  resetRealtimeAudienceCache();
  mocks.broadcast.mockReset();
  mocks.broadcastToUsers.mockReset();
  mocks.broadcastToUsers.mockReturnValue(1);
  mocks.user = { userId: 100, role: 2 };
  mocks.deleted = false;
  mocks.domains.clear();
  mocks.domains.set(11, { id: 11, name: 'a.com', account_id: 5, enabled: 1, remark: null });
  mocks.domains.set(12, { id: 12, name: 'b.com', account_id: 5, enabled: 1, remark: null });
});

describe('域名事件的推送范围', () => {
  it('更新域名只推给能读到该域名的用户，不再全局广播', async () => {
    const res = await call('PUT', '/api/domains/11', { remark: 'updated' });
    expect(res.status).toBe(200);

    expect(audiences()).toEqual([[1, 100]]);
    expect(mocks.broadcastToUsers).toHaveBeenCalledWith(
      [100, 1],
      expect.objectContaining({
        type: 'domain_updated',
        data: expect.objectContaining({ domainId: 11, name: 'a.com' }),
      }),
    );
    // 回归闸门：备注/到期时间不得再推给所有人
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('删除域名的收件人在删除之前算出，删除后仍能通知到原可见用户', async () => {
    const res = await call('DELETE', '/api/domains/11');
    expect(res.status).toBe(200);

    // 若收件人算在删除之后，getById 已查不到域名，这里会是空集
    expect(audiences()).toEqual([[1, 100]]);
    expect(mocks.broadcastToUsers).toHaveBeenCalledWith(
      [100, 1],
      expect.objectContaining({
        type: 'domain_deleted',
        data: expect.objectContaining({ domainId: 11, name: 'a.com' }),
      }),
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('新建域名只推给能读到该域名的用户，不再全局广播', async () => {
    const res = await call('POST', '/api/domains', { account_id: 5, name: 'b.com' });
    expect(res.status).toBe(200);

    expect(audiences()).toEqual([[1, 100]]);
    expect(mocks.broadcastToUsers).toHaveBeenCalledWith(
      [100, 1],
      expect.objectContaining({
        type: 'domain_created',
        data: expect.objectContaining({ domainId: 12, name: 'b.com', count: 1 }),
      }),
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('续期事件只推给管理员（口径同 GET /renewable-domains），普通用户不推送', async () => {
    const res = await call('POST', '/api/domains/3/renew');
    expect(res.status).toBe(200);

    // admin 100 / 200 与超管 1；普通用户 300 不在收件人里
    expect(audiences()).toEqual([[1, 100, 200]]);
    expect(mocks.broadcastToUsers).toHaveBeenCalledWith(
      [1, 100, 200],
      expect.objectContaining({
        type: 'domain_renewed',
        data: expect.objectContaining({ renewableDomainId: 3, fullDomain: 'r.com' }),
      }),
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('普通用户调用续期接口被拒且不推送', async () => {
    mocks.user = { userId: 300, role: 1 };

    const res = await call('POST', '/api/domains/3/renew');
    // sendError 默认 HTTP 200 + code -1（见 utils/http.sendError）
    expect(((await res.json()) as { code: number }).code).toBe(-1);

    expect(mocks.broadcastToUsers).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });
});
