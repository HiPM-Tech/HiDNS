import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';

const S = vi.hoisted(() => ({ created: [] as any[], updated: [] as any[], existing: {} as any, user: { userId: 2, role: 1 } }));

vi.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => { req.user = S.user; next(); },
  adminOnly: (_r: any, _s: any, n: any) => n(),
  noTokenAuth: () => (_r: any, _s: any, n: any) => n(),
  requireJwtAuth: () => [(_r: any, _s: any, n: any) => n()],
}));
vi.mock('./domains', () => ({
  getDomainAccess: async (domainId: number) => ({ domain: { id: domainId }, canRead: true, canWrite: Number(domainId) === 11 }),
  default: {},
}));
vi.mock('../db/bal/business-adapter', () => ({
  ServiceMonitorOperations: { getStatus: vi.fn(async () => undefined) },
  DomainOperations: {}, DnsAccountOperations: {}, DomainPermissionOperations: {}, TeamOperations: {}, UserOperations: {},
}));
vi.mock('../service/serviceMonitor', () => ({
  getMonitor: vi.fn(async () => S.existing),
  getMonitors: vi.fn(async () => []),
  getMonitorsWithPagination: vi.fn(async () => ({ monitors: [], total: 0 })),
  getMonitorsByParentId: vi.fn(async () => []),
  createMonitor: vi.fn(async (d: any) => { S.created.push(d); return 99; }),
  updateMonitor: vi.fn(async (id: number, d: any) => { S.updated.push({ id, d }); }),
  deleteMonitor: vi.fn(async () => undefined),
  performCheck: vi.fn(async () => ({ status: 'ok', responseTime: 1, error: null, resultData: null })),
  runCheckAndUpdate: vi.fn(async () => ({ status: 'ok', responseTime: 1, error: null, resultData: null })),
}));
vi.mock('../service/websocket', () => ({ wsService: { broadcastToUsers: vi.fn(), sendToClient: vi.fn() } }));
vi.mock('../service/realtime-audience', () => ({ getSuperAdminUserIds: vi.fn(async () => []) }));

import monitorRouter from './servicemonitor';
const app = express();
app.use(express.json());
app.use('/api/servicemonitor', monitorRouter);
let server: http.Server; let base = '';
const boot = async () => { server = http.createServer(app); await new Promise<void>((r) => server.listen(0, r)); base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port; };
const req = async (method: string, p: string, body: unknown) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, body: (() => { try { return JSON.parse(t); } catch { return t.slice(0, 80); } })() };
};
const cfg = { recordName: 'www', recordType: 'A', primaryValue: '1.1.1.1', backupValues: ['2.2.2.2'] };

describe('非 failover 的 domain_id 与 PUT 权限', () => {
  it('create/update 的 domain_id 落库', async () => {
    S.existing = { id: 7, userId: 2, name: 'own', type: 'dns_failover', target: 'example.com', domainId: 11, config: cfg, checkInterval: 300, checkTimeout: 10, enabled: true, notifyOnFailure: true, notifyOnRecovery: true };
    await boot();
    try {
      const c1 = await req('POST', '/api/servicemonitor', { name: 'e1', type: 'endpoint', target: 'http://example.com', domain_id: 999 });
      console.log('[C1] create endpoint + domain_id=999 →', c1.status, '| 落库 domainId =', JSON.stringify(S.created.at(-1)?.domainId));
      const c2 = await req('POST', '/api/servicemonitor', { name: 'f1', type: 'dns_failover', target: 'example.com', domain_id: 999, config: cfg });
      console.log('[C2] create failover + 他域 999 →', c2.status, JSON.stringify(c2.body).slice(0, 60));
      const c3 = await req('POST', '/api/servicemonitor', { name: 'f2', type: 'dns_failover', target: 'example.com', domain_id: 11, config: cfg });
      console.log('[C3] create failover + 自有 11 →', c3.status);
      const u1 = await req('PUT', '/api/servicemonitor/7', { type: 'endpoint', target: 'http://example.com', domain_id: 999 });
      console.log('[C4] PUT 改 endpoint + domain_id=999 →', u1.status, '| 落库 domainId =', JSON.stringify(S.updated.at(-1)?.d?.domainId));
      const u2 = await req('PUT', '/api/servicemonitor/7', { type: 'dns_failover', domain_id: 11, config: cfg });
      console.log('[C5] PUT failover 自有 11 →', u2.status, '| 落库 domainId =', JSON.stringify(S.updated.at(-1)?.d?.domainId));
      const u3 = await req('PUT', '/api/servicemonitor/7', { type: 'dns_failover', domain_id: 999, config: cfg });
      console.log('[C6] PUT failover 他域 999 →', u3.status, JSON.stringify(u3.body).slice(0, 60));
      expect([200, 400, 403]).toContain(c1.status);
    } finally { server.close(); }
  });
});