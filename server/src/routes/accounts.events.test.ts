import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import http, { Server } from 'http';
import { AddressInfo } from 'net';

const mocks = vi.hoisted(() => ({
  account: { id: 7, name: 'fixture', type: 'cloudflare', config: '{"apiKey":"fixture-secret"}', enabled: 1, created_by: 1, team_id: null },
  broadcast: vi.fn(),
}));
vi.mock('../db/bal/business-adapter', () => ({
  DnsAccountOperations: {
    getAll: vi.fn(async () => []), getById: vi.fn(async () => mocks.account),
    create: vi.fn(async () => 7), update: vi.fn(), updateEnabled: vi.fn(),
  }, TeamOperations: {}, SettingsOperations: {},
}));
vi.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => { req.user = { userId: 1, role: 3 }; next(); },
}));
vi.mock('../lib/dns/DnsHelper', () => ({
  createAdapter: () => ({ check: async () => true }), getProvider: () => ({}),
  getProviders: () => [], isStubProvider: () => false,
}));
vi.mock('../service/websocket', () => ({ wsService: { broadcast: mocks.broadcast } }));
vi.mock('../service/audit', () => ({ logAuditOperation: vi.fn() }));
import accountsRouter from './accounts';

let server: Server;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/accounts', accountsRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => mocks.broadcast.mockClear());
it.each([
  ['POST', '/api/accounts', { type: 'cloudflare', name: 'fixture', config: { apiKey: 'fixture-secret' } }, 'account_created'],
  ['PUT', '/api/accounts/7', { remark: 'updated' }, 'account_updated'],
  ['PATCH', '/api/accounts/7/toggle-enabled', { enabled: true }, 'account_updated'],
] as const)('%s %s broadcasts metadata without credentials', async (method, path, data, eventType) => {
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  expect(response.status).toBe(200);
  expect((await response.json() as { code: number }).code).toBe(0);
  expect(mocks.broadcast).toHaveBeenCalledOnce();
  const event = mocks.broadcast.mock.calls[0][0];
  expect(event.type).toBe(eventType);
  expect(event.data.accountId).toBe(7);
  expect(event.data.account.id).toBe(7);
  expect(event.data.account).not.toHaveProperty('config');
  expect(JSON.stringify(event)).not.toContain('fixture-secret');
  expect(mocks.account.config).toContain('fixture-secret');
});
