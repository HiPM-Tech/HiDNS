import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TokenPayload } from '../../types/token';

vi.mock('../../service/token', async importOriginal => ({
  ...await importOriginal<typeof import('../../service/token')>(),
  verifyToken: vi.fn(),
  updateTokenPermissions: vi.fn(),
}));
vi.mock('../../service/jwt', () => ({ getJwtSecret: async () => 'test-secret', signToken: vi.fn() }));

import { updateTokenPermissions, verifyToken } from '../../service/token';
import { authMiddleware } from '../../middleware/auth';
import tokensRouter from '../../routes/tokens';
import { mountApiModules } from '../mount';
import { dnsPermissionForRoute } from '../token-permissions';

let server: Server;
let origin: string;
let writes = 0;
const base: TokenPayload = { type: 'token', tokenId: 1, userId: 1, maxRole: 3, allowedDomains: [], allowedServices: {} };
const credentials: Record<string, TokenPayload> = {
  read: { ...base, allowedServices: { dns: ['records.read'] } },
  write: { ...base, allowedServices: { dns: ['records.write'] } },
  dns: { ...base, allowedServices: { dns: ['*'] } },
  mcp: { ...base, allowedServices: { mcp: ['*'] } },
  empty: base,
};

beforeAll(async () => {
  vi.mocked(verifyToken).mockImplementation(async token => credentials[token] ?? null);
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/tokens', tokensRouter);
  const domains = express.Router();
  domains.get('/:id', authMiddleware, (_req, res) => res.json({ code: 0 }));
  const records = express.Router({ mergeParams: true });
  records.get('/', authMiddleware, (_req, res) => res.json({ code: 0 }));
  records.put('/:recordId', authMiddleware, (_req, res) => { writes++; res.json({ code: 0 }); });
  records.post('/batch', authMiddleware, (_req, res) => { writes++; res.json({ code: 0 }); });
  records.delete('/:recordId', authMiddleware, (_req, res) => { writes++; res.json({ code: 0 }); });
  records.put('/:recordId/status', authMiddleware, (_req, res) => { writes++; res.json({ code: 0 }); });
  const mcp = express.Router();
  mcp.get('/config', authMiddleware, (_req, res) => res.json({ code: 0 }));
  mountApiModules(app, [
    { id: 'domains', prefix: '/api/domains', service: 'dns', router: domains, description: 'test domains' },
    { id: 'records', prefix: '/api/domains/:domainId/records', service: 'dns', router: records, description: 'test records' },
    { id: 'mcp', prefix: '/api/mcp', service: 'mcp', router: mcp, description: 'test MCP' },
  ]);
  server = await new Promise<Server>(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server?.close(error => error ? reject(error) : resolve()));
});

async function request(path: string, credential: string, method = 'GET', cookie = false) {
  return fetch(origin + path, { method, headers: cookie
    ? { Cookie: `token=${credential}` } : { Authorization: `Bearer ${credential}` } });
}

describe('API token operation authorization', () => {
  it('只读令牌可读记录但不能访问域名列表以外的资源；无凭据返回 401', async () => {
    expect((await request('/api/domains/11/records', 'read')).status).toBe(200);
    expect((await request('/api/domains/11', 'read')).status).toBe(403);
    expect((await fetch(origin + '/api/domains/11/records')).status).toBe(401);
  });

  it.each([
    ['PUT', '/api/domains/11/records/22'],
    ['POST', '/api/domains/11/records/batch'],
    ['DELETE', '/api/domains/11/records/22'],
    ['PUT', '/api/domains/11/records/22/status'],
  ])('只读令牌拒绝 %s %s，且不执行业务写入', async (method, path) => {
    const before = writes;
    const response = await request(path, 'read', method);
    expect(response.status).toBe(403);
    expect((await response.json()).msg).toContain('records.write');
    expect(writes).toBe(before);
    expect((await request(path, 'write', method)).status).toBe(200);
    expect(writes).toBe(before + 1);
  });

  it('写权限不隐含读权限，HEAD 也按读取校验', async () => {
    expect((await request('/api/domains/11/records', 'write')).status).toBe(403);
    expect((await request('/api/domains/11/records', 'read', 'HEAD')).status).toBe(200);
  });

  it('服务隔离、空权限与旧等效通配权限', async () => {
    expect((await request('/api/domains/11/records/22', 'mcp', 'PUT')).status).toBe(403);
    expect((await request('/api/mcp/config', 'dns')).status).toBe(403);
    expect((await request('/api/mcp/config', 'mcp')).status).toBe(200);
    expect((await request('/api/domains/11/records', 'empty')).status).toBe(403);
    expect((await request('/api/domains/11/records/22', 'dns', 'PUT')).status).toBe(200);
  });

  it('大小写与尾斜线不会绕过权限，cookie 内 UserToken 同样校验', async () => {
    expect((await request('/API/DOMAINS/11/RECORDS/22/', 'read', 'PUT')).status).toBe(403);
    expect((await request('/api/domains/11/records/22', 'read', 'PUT', true)).status).toBe(403);
  });

  it('JWT 会话不受 UserToken 操作权限影响', async () => {
    const token = jwt.sign({ userId: 1, role: 3 }, 'test-secret');
    expect((await request('/api/domains/11/records/22', token, 'PUT')).status).toBe(200);
  });

  it('更新 Token 接口接受对象，拒绝旧数组和错误权限且不执行更新', async () => {
    const token = jwt.sign({ userId: 1, role: 3 }, 'test-secret');
    const update = (allowed_services: unknown) => fetch(origin + '/api/tokens/1', {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowed_services }),
    });
    vi.mocked(updateTokenPermissions).mockClear();
    for (const value of [['dns'], { dns: ['records.typo'] }, { mcp: ['tools.call'] }, null]) {
      expect((await update(value)).status).toBe(400);
    }
    expect(updateTokenPermissions).not.toHaveBeenCalled();
    expect((await update({ dns: ['records.read'], mcp: ['*'] })).status).toBe(200);
    expect(updateTokenPermissions).toHaveBeenCalledWith(1, 1, expect.objectContaining({
      allowed_services: { dns: ['records.read'], mcp: ['*'] },
    }));
  });
});

describe('DNS route permission policy', () => {
  it.each([
    ['/api/accounts', 'GET', '/providers', 'providers.read'],
    ['/api/accounts', 'POST', '/', 'accounts.write'],
    ['/api/domains', 'POST', '/sync', 'domains.write'],
    ['/api/domains', 'GET', '/:id/lines', 'records.read'],
    ['/api/domains', 'GET', '/:id/record-types', 'records.read'],
    ['/api/domains/email-templates', 'GET', '/:templateId/preview', 'email-templates.read'],
    ['/api/providers', 'GET', '/:type/renewable-domains', 'providers.read'],
    ['/api/ns-monitor', 'POST', '/resolve-ns', 'ns-monitor.read'],
    ['/api/ns-monitor', 'POST', '/check', 'ns-monitor.write'],
    ['/api/servicemonitor', 'POST', '/:id/check', 'servicemonitor.write'],
    ['/api/workflows', 'GET', '/:id/runs', 'workflow.read'],
    ['/api/workflows', 'POST', '/:id/run', 'workflow.run'],
    ['/api/workflows', 'PUT', '/:id', 'workflow.write'],
    ['/api/mcp', 'GET', '/config', null],
  ])('%s %s %s requires %s', (baseUrl, method, path, expected) => {
    expect(dnsPermissionForRoute(baseUrl, method, path)).toBe(expected);
  });
});
