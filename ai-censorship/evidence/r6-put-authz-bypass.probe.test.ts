import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';

const S = vi.hoisted(() => ({ user: { userId: 2, role: 1 }, updates: [] as any[], existing: {} as any }));

vi.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => { req.user = S.user; next(); },
  adminOnly: (_r: any, _s: any, n: any) => n(),
  noTokenAuth: () => (_r: any, _s: any, n: any) => n(),
  requireJwtAuth: () => [(_r: any, _s: any, n: any) => n()],
  requireTokenDomainPermission: () => (_r: any, _s: any, n: any) => n(),
  requireDomainPermission: () => (_r: any, _s: any, n: any) => n(),
}));
vi.mock('./domains', () => ({ default: {} }));
vi.mock('../db/bal/business-adapter', () => ({
  DomainOperations: { getById: vi.fn(async (id: number) => ({ id, account_id: 5, name: 'd' + id })) },
  ServiceMonitorOperations: { getStatus: vi.fn(async () => undefined), update: vi.fn(async () => undefined) },
  DnsAccountOperations: { getById: vi.fn(async () => ({ id: 5, type: 'cloudflare', config: '{}', created_by: 2, enabled: 1 })) },
  DomainPermissionOperations: { hasRules: vi.fn(async () => false), getByDomainAndUser: vi.fn(async () => []), getByDomainAndTeamMember: vi.fn(async () => []) },
  TeamOperations: { getTeamIdsByUserId: vi.fn(async () => []) },
  UserOperations: { getAll: vi.fn(async () => []) },
}));
vi.mock('../service/serviceMonitor', () => ({
  getMonitor: vi.fn(async () => S.existing),
  getMonitors: vi.fn(async () => []),
  getMonitorsWithPagination: vi.fn(async () => ({ monitors: [], total: 0 })),
  getMonitorsByParentId: vi.fn(async () => []),
  createMonitor: vi.fn(async () => 99),
  updateMonitor: vi.fn(async (id: number, d: any) => { S.updates.push({ id, d }); }),
  deleteMonitor: vi.fn(async () => undefined),
  performCheck: vi.fn(async () => ({ status: 'ok', responseTime: 1, error: null, resultData: null })),
  runCheckAndUpdate: vi.fn(async () => ({ status: 'ok', responseTime: 1, error: null, resultData: null })),
}));
vi.mock('../service/websocket', () => ({ wsService: { broadcastToUsers: vi.fn(), sendToClient: vi.fn() } }));
vi.mock('../service/realtime-audience', () => ({ getSuperAdminUserIds: vi.fn(async () => []) }));
vi.mock('../service/audit', () => ({ logAuditOperation: vi.fn(async () => undefined) }));

import monitorRouter from './servicemonitor';
const app = express();
app.use(express.json());
app.use('/api/servicemonitor', monitorRouter);
let server: http.Server; let base = '';
const boot = async () => { server = http.createServer(app); await new Promise<void>((r) => server.listen(0, r)); base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port; };
const put = async (body: unknown) => {
  const r = await fetch(base + '/api/servicemonitor/7', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text(); return { status: r.status, body: (() => { try { return JSON.parse(t); } catch { return t.replace(/\s+/g, ' ').slice(0, 220); } })() };
};
const baseExisting = () => ({ id: 7, userId: 2, name: 'own', type: 'dns_failover', target: 'example.com', domainId: 11, config: { primaryValue: '1.1.1.1', backupValues: ['2.2.2.2'], recordName: 'www', recordType: 'A' }, checkInterval: 300, checkTimeout: 10, enabled: true, notifyOnFailure: true, notifyOnRecovery: true });

describe('PUT 监控越权绕过复核', () => {
  it('绕过尝试', async () => {
    S.existing = baseExisting(); await boot();
    try {
      const r1 = await put({ domain_id: 999, config: { recordName: 'www', recordType: 'A', primaryValue: '1.1.1.1', backupValues: ['2.2.2.2'] } });
      console.log('[B1] dns_failover 直改他域 →', r1.status, String(JSON.stringify(r1.body)).slice(0, 220));
      const r2 = await put({ type: 'endpoint', domain_id: 999, target: 'http://example.com', config: { recordName: 'www', recordType: 'A', primaryValue: '1.1.1.1', backupValues: ['2.2.2.2'] } });
      console.log('[B2] 先改 type=endpoint + 他域 →', r2.status, '| 落库 domainId =', JSON.stringify(S.updates.at(-1)?.d?.domainId));
      S.existing = { ...baseExisting(), type: 'endpoint', domainId: 999 };
      const r3 = await put({ type: 'dns_failover', config: { recordName: 'www', recordType: 'A', primaryValue: '1.1.1.1', backupValues: ['2.2.2.2'] } });
      console.log('[B3] 再改回 dns_failover（不带 domain_id） →', r3.status, JSON.stringify(r3.body).slice(0, 60));
      S.existing = baseExisting();
      const r4 = await put({ type: 'dns_failover', domain_id: null, config: { recordName: 'www', recordType: 'A', primaryValue: '1.1.1.1', backupValues: ['2.2.2.2'] } });
      console.log('[B4] domain_id=null（existing=11 自有） →', r4.status, '| 落库 =', JSON.stringify(S.updates.at(-1)?.d?.domainId));
      S.existing = baseExisting();
      const r5 = await put({ type: 'dns_failover', parent_id: 999, config: { recordName: 'www', recordType: 'A', primaryValue: '1.1.1.1', backupValues: ['2.2.2.2'] } });
      console.log('[B5] parent_id=999（父监控属他人） →', r5.status);
      S.existing = baseExisting();
      const rOwn = await put({ type: 'dns_failover', domain_id: 11, config: { recordName: 'www', recordType: 'A', primaryValue: '1.1.1.1', backupValues: ['2.2.2.2'] } });
      console.log('[B0] 自有域名(11) 改 dns_failover →', rOwn.status, String(JSON.stringify(rOwn.body)).slice(0, 90));
      const r6 = await put({ type: 'evil' });
      console.log('[B6] type=evil →', r6.status, JSON.stringify(r6.body).slice(0, 60));
      const r7 = await put({ type: 'dns_failover', domain_id: '999abc', config: { recordName: 'www', recordType: 'A', primaryValue: '1.1.1.1', backupValues: ['2.2.2.2'] } });
      console.log('[B7] domain_id=字符串 999abc →', r7.status);
      expect(r1.status).toBe(403);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(403);
      expect(r6.status).toBe(400);
      expect(r7.status).toBe(403);
    } finally { server.close(); }
  });
});