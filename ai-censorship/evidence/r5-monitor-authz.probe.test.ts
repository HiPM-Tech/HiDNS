import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';

const S = vi.hoisted(() => ({
  user: { userId: 2, role: 1 },
  created: [] as any[],
  updated: [] as any[],
  accessCalls: [] as any[],
  accessAllowed: true,
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => { req.user = S.user; next(); },
  adminOnly: (_r: any, _s: any, n: any) => n(),
  noTokenAuth: () => (_r: any, _s: any, n: any) => n(),
  requireJwtAuth: () => [(_r: any, _s: any, n: any) => n()],
  requireTokenDomainPermission: () => (_r: any, _s: any, n: any) => n(),
  requireDomainPermission: () => (_r: any, _s: any, n: any) => n(),
}));
vi.mock('../routes/domains', () => ({
  getDomainAccess: async (domainId: number) => { S.accessCalls.push(domainId); return { domain: { id: domainId }, canRead: true, canWrite: S.accessAllowed, writeSubs: null, hasRules: false }; },
  default: {},
}));
vi.mock('../db/bal/business-adapter', () => ({
  ServiceMonitorOperations: {
    getById: vi.fn(async (id: number) => ({ id, user_id: 2, name: 'own', type: 'dns_failover', target: 'example.com', domain_id: 11, config: JSON.stringify({ primaryValue: '1.1.1.1', backupValues: ['2.2.2.2'], recordName: 'www', recordType: 'A' }), check_interval: 300, check_timeout: 10, enabled: 1 })),
    create: vi.fn(async (d: any) => { S.created.push(d); return 99; }),
    update: vi.fn(async (id: number, d: any) => { S.updated.push({ id, d }); }),
    getStatus: vi.fn(async () => undefined),
    getByUserWithPagination: vi.fn(async () => ({ list: [], total: 0 })),
    getByParentId: vi.fn(async () => []),
    getByUser: vi.fn(async () => []),
    getAllEnabled: vi.fn(async () => []),
    delete: vi.fn(async () => undefined),
    upsertStatus: vi.fn(async () => undefined),
  },
  DnsAccountOperations: { getById: vi.fn(async () => ({ id: 5, type: 'cloudflare', config: '{}' })) },
  DomainPermissionOperations: { hasRules: vi.fn(async () => false), getByDomainAndUser: vi.fn(async () => []), getByDomainAndTeamMember: vi.fn(async () => []) },
  TeamOperations: { getTeamIdsByUserId: vi.fn(async () => []), isMember: vi.fn(async () => false) },
  UserOperations: { getAll: vi.fn(async () => []) },
  SystemCacheOperations: { get: vi.fn(async () => undefined), set: vi.fn(async () => undefined) },
}));
vi.mock('../service/serviceMonitor', () => ({
  getMonitor: vi.fn(async (id: number) => ({ id, userId: 2, name: 'own', type: 'dns_failover', target: 'example.com', domainId: 11, config: { primaryValue: '1.1.1.1', backupValues: ['2.2.2.2'], recordName: 'www', recordType: 'A' }, checkInterval: 300, checkTimeout: 10, enabled: true })),
  getMonitorsWithPagination: vi.fn(async () => ({ monitors: [], total: 0 })),
  createMonitor: vi.fn(async (d: any) => { S.created.push(d); return 99; }),
  updateMonitor: vi.fn(async (id: number, d: any) => { S.updated.push({ id, d }); }),
  deleteMonitor: vi.fn(async () => undefined),
  performCheck: vi.fn(async () => ({ status: 'ok', responseTime: 1, error: null, resultData: null })),
  getAvailableDomains: vi.fn(async () => []),
  checkMonitorNow: vi.fn(async () => ({ status: 'ok', responseTime: 1, error: null, resultData: null })),
}));
vi.mock('../service/websocket', () => ({ wsService: { broadcastToUsers: vi.fn(), sendToClient: vi.fn() } }));
vi.mock('../service/realtime-audience', () => ({ getSuperAdminUserIds: vi.fn(async () => []), getMonitorAudienceUserIds: vi.fn(async () => []), getDomainAudienceUserIds: vi.fn(async () => []) }));
vi.mock('../service/audit', () => ({ logAuditOperation: vi.fn(async () => undefined) }));

import monitorRouter from './servicemonitor';
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/servicemonitor', monitorRouter);
let server: http.Server; let base = '';
const boot = async () => { server = http.createServer(app); await new Promise<void>((r) => server.listen(0, r)); base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port; };
const post = async (p: string, body: unknown) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, body: (() => { try { return JSON.parse(t); } catch { return t.slice(0, 100); } })() };
};

describe('监控校验与权限（对抗复核）', () => {
  it('validateMonitorInput 的绕过面', async () => {
    await boot();
    try {
      const cases: Array<[string, any]> = [
        ['config 字符串带 port 70000', { name: 'x1', type: 'ssl_certificate', target: 'example.com', config: '{"port":70000}' }],
        ['config 对象 port 70000', { name: 'x2', type: 'ssl_certificate', target: 'example.com', config: { port: 70000 } }],
        ['interval 30.5', { name: 'x3', type: 'ssl_certificate', target: 'example.com', check_interval: 30.5 }],
        ['interval "1e3"', { name: 'x4', type: 'ssl_certificate', target: 'example.com', check_interval: '1e3' }],
        ['interval " 30 "', { name: 'x5', type: 'ssl_certificate', target: 'example.com', check_interval: ' 30 ' }],
        ['ssl 目标带路径', { name: 'x6', type: 'ssl_certificate', target: 'example.com/foo' }],
        ['endpoint 目标 ftp://', { name: 'x7', type: 'endpoint', target: 'ftp://example.com' }],
        ['endpoint 目标 "http://"', { name: 'x8', type: 'endpoint', target: 'http://' }],
        ['endpoint checkPath //evil', { name: 'x9', type: 'endpoint', target: 'http://example.com', config: { path: '/', checkPath: '//evil.com/x' } }],
        ['port true', { name: 'x10', type: 'ssl_certificate', target: 'example.com', config: { port: true } }],
        ['config 字符串 allowPrivate', { name: 'x11', type: 'ssl_certificate', target: '127.0.0.1', config: '{"allowPrivate":true}' }],
        ['config 对象 allowPrivate', { name: 'x12', type: 'ssl_certificate', target: '127.0.0.1', config: { allowPrivate: true } }],
        ['expectedBody 500KB', { name: 'x13', type: 'endpoint', target: 'http://example.com', config: { expectedBody: 'x'.repeat(500000) } }],
      ];
      for (const [label, body] of cases) {
        const r = await post('/api/servicemonitor', body);
        console.log('[CASE]', label, '→', r.status, JSON.stringify(r.body).slice(0, 90));
      }
      console.log('[CREATED]', JSON.stringify(S.created.map((c) => ({ name: c.name, configType: typeof c.config, config: c.config, checkInterval: c.checkInterval, target: c.target }))));
      expect(S.created.length).toBeGreaterThan(0);
    } finally { server.close(); }
  });

  it('PUT 是否复核 dns_failover 的域名写权限', async () => {
    S.accessCalls = []; S.updated = []; S.user = { userId: 2, role: 1 };
    await boot();
    try {
      const res = await fetch(base + '/api/servicemonitor/7', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain_id: 999, config: { primaryValue: '1.1.1.1', backupValues: ['2.2.2.2'], recordName: 'www', recordType: 'A' } }) });
      const text = await res.text();
      console.log('[PUT] 改 domain_id → 999 →', res.status, text.slice(0, 160), '| getDomainAccess 调用次数 =', S.accessCalls.length, '| update 载荷 =', JSON.stringify(S.updated).slice(0, 160));
      expect(res.status).toBe(200);
      expect(S.accessCalls.length).toBe(0);
    } finally { server.close(); }
  });
});
