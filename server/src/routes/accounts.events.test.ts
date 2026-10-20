import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import http, { Server } from 'http';
import { AddressInfo } from 'net';

/**
 * 回归目标（两件事一起锁）：
 * 1) account_* 事件不得再走全局广播——payload 带账号名/服务商/团队归属，
 *    全局广播等于把「谁在用哪家 DNS 服务商」推给所有在线客户端。
 *    收件人口径 = 本文件 canReadAccount()：超管 / 创建者 / 团队成员。
 * 2) payload 里不得出现服务商凭据（config），这条原有断言继续保留。
 */
const mocks = vi.hoisted(() => ({
  account: { id: 7, name: 'fixture', type: 'cloudflare', config: '{"apiKey":"fixture-secret"}', enabled: 1, created_by: 100, team_id: null as number | null },
  broadcast: vi.fn(),
  broadcastToUsers: vi.fn(),
  user: { userId: 100, role: 2 },
  teamMembers: [] as Array<{ user_id: number }>,
}));

vi.mock('../db/bal/business-adapter', () => ({
  DnsAccountOperations: {
    getAll: vi.fn(async () => []),
    getById: vi.fn(async () => mocks.account),
    create: vi.fn(async () => 7),
    update: vi.fn(),
    updateEnabled: vi.fn(),
    delete: vi.fn(),
  },
  TeamOperations: {
    getMembers: vi.fn(async () => mocks.teamMembers),
    isMember: vi.fn(async () => false),
    getByUserId: vi.fn(async () => []),
  },
  SettingsOperations: { get: vi.fn(async () => null) },
  UserOperations: {
    getAll: vi.fn(async () => [
      { id: 1, role_level: 3, status: 1 },
      { id: 100, role_level: 2, status: 1 },
      { id: 200, role_level: 2, status: 1 },
      { id: 300, role_level: 1, status: 1 },
    ]),
  },
}));
vi.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = mocks.user;
    next();
  },
}));
vi.mock('../lib/dns/DnsHelper', () => ({
  createAdapter: () => ({ check: async () => true }), getProvider: () => ({}),
  getProviders: () => [], isStubProvider: () => false,
}));
vi.mock('../service/websocket', () => ({
  wsService: { broadcast: mocks.broadcast, broadcastToUsers: mocks.broadcastToUsers },
}));
vi.mock('../service/audit', () => ({ logAuditOperation: vi.fn() }));

import accountsRouter from './accounts';
import { resetRealtimeAudienceCache } from '../service/realtime-audience';

let server: Server;

function audiences(): number[][] {
  return mocks.broadcastToUsers.mock.calls.map((call) =>
    [...(call[0] as number[])].sort((a, b) => a - b),
  );
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountsRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

beforeEach(() => {
  resetRealtimeAudienceCache();
  mocks.broadcast.mockReset();
  mocks.broadcastToUsers.mockReset();
  mocks.broadcastToUsers.mockReturnValue(1);
  mocks.user = { userId: 100, role: 2 };
  mocks.teamMembers = [];
  mocks.account = {
    id: 7, name: 'fixture', type: 'cloudflare',
    config: '{"apiKey":"fixture-secret"}', enabled: 1, created_by: 100, team_id: null,
  };
});

it.each([
  ['POST', '/api/accounts', { type: 'cloudflare', name: 'fixture', config: { apiKey: 'fixture-secret' } }, 'account_created'],
  ['PUT', '/api/accounts/7', { remark: 'updated' }, 'account_updated'],
  ['PATCH', '/api/accounts/7/toggle-enabled', { enabled: true }, 'account_updated'],
] as const)('%s %s 只推给能读到该账号的用户，且不带凭据', async (method, path, data, eventType) => {
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  expect(response.status).toBe(200);
  expect((await response.json() as { code: number }).code).toBe(0);

  // 收件人 = 超管 1 + 创建者 100；非相关用户 200/300 不在其中
  expect(audiences()).toEqual([[1, 100]]);
  // 回归闸门：账号元信息不得再推给所有人
  expect(mocks.broadcast).not.toHaveBeenCalled();

  const event = mocks.broadcastToUsers.mock.calls[0][1];
  expect(event.type).toBe(eventType);
  expect(event.data.accountId).toBe(7);
  expect(event.data.account.id).toBe(7);
  expect(event.data.account).not.toHaveProperty('config');
  expect(JSON.stringify(event)).not.toContain('fixture-secret');
  expect(mocks.account.config).toContain('fixture-secret');
});

it('DELETE /api/accounts/7 的收件人在删除之前算出，且不全局广播', async () => {
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/accounts/7`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
  });
  expect(response.status).toBe(200);
  expect((await response.json() as { code: number }).code).toBe(0);

  expect(audiences()).toEqual([[1, 100]]);
  expect(mocks.broadcastToUsers.mock.calls[0][1]).toMatchObject({
    type: 'account_deleted',
    data: { accountId: 7, name: 'fixture' },
  });
  expect(mocks.broadcast).not.toHaveBeenCalled();
});

it('团队共享账号：团队成员同样收到（只按创建者收口会漏推）', async () => {
  mocks.account.team_id = 9;
  mocks.teamMembers = [{ user_id: 300 }, { user_id: 301 }];

  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/accounts/7/toggle-enabled`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }),
  });
  expect(response.status).toBe(200);

  expect(audiences()).toEqual([[1, 100, 300, 301]]);
  expect(mocks.broadcast).not.toHaveBeenCalled();
});
