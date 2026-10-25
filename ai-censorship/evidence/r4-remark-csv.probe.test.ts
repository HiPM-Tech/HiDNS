import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';

const S = vi.hoisted(() => ({ created: [] as any[], remarkUpdates: [] as any[], logs: [] as any[] }));

vi.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => { req.user = { userId: 1, role: 3 }; next(); },
  adminOnly: (_r: any, _s: any, n: any) => n(),
  requireTokenDomainPermission: () => (_r: any, _s: any, n: any) => n(),
  requireDomainPermission: () => (_r: any, _s: any, n: any) => n(),
  noTokenAuth: () => (_r: any, _s: any, n: any) => n(),
  requireJwtAuth: () => [(_r: any, _s: any, n: any) => n()],
}));
vi.mock('../db/bal/business-adapter', () => ({
  DomainOperations: {
    getById: vi.fn(async () => ({ id: 1, name: 'a.com', account_id: 5, enabled: 1, remark: null })),
    getAllForSuperAdmin: vi.fn(async () => []),
    getAllForSuperAdminWithPagination: vi.fn(async () => ({ list: [], total: 0 })),
    getAccessibleDomains: vi.fn(async () => []),
    getAccessibleDomainsWithPagination: vi.fn(async () => ({ list: [], total: 0 })),
    getByAccountIdAndName: vi.fn(async () => undefined),
    create: vi.fn(async (d: any) => { S.created.push(d); return S.created.length; }),
    updateThirdIdAndRecordCount: vi.fn(async () => undefined),
    updateRemarkAndHidden: vi.fn(async (id: number, remark: string) => { S.remarkUpdates.push([id, remark]); }),
    updateRecordCount: vi.fn(async () => undefined),
    getAll: vi.fn(async () => []),
  },
  DnsAccountOperations: { getById: vi.fn(async () => ({ id: 5, type: 'cloudflare', config: '{}', created_by: 1, enabled: 1 })), getCreatedBy: vi.fn(async () => 1), getAll: vi.fn(async () => []) },
  DomainPermissionOperations: { hasRules: vi.fn(async () => false), getByDomainAndUser: vi.fn(async () => []), getByDomainAndTeamMember: vi.fn(async () => []), getByDomainId: vi.fn(async () => []) },
  TeamOperations: { getTeamIdsByUserId: vi.fn(async () => []), getMembers: vi.fn(async () => []), isMember: vi.fn(async () => false) },
  UserOperations: { getAll: vi.fn(async () => []) },
  SystemCacheOperations: { get: vi.fn(async () => undefined), set: vi.fn(async () => undefined) },
  RenewableDomainOperations: { getById: vi.fn(async () => undefined) },
  NSMonitorOperations: { getUserMonitors: vi.fn(async () => []) },
  UserPreferencesOperations: { get: vi.fn(async () => undefined) },
  WhoisOperations: {},
  McpOperations: { getAuditLogs: vi.fn(async () => S.logs) },
  GroupedDomainsCacheOperations: { get: vi.fn(async () => null), set: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) },
}));
vi.mock('../service/groupedCacheJob', () => ({
  getCacheVersion: vi.fn(async () => 1), setCachedGroupedData: vi.fn(async () => undefined),
  getCachedGroupedData: vi.fn(async () => null), bumpCacheVersion: vi.fn(async () => 1), submitGroupedCacheUpdate: vi.fn(),
}));
vi.mock('../service/audit', () => ({ logAuditOperation: vi.fn(async () => undefined) }));
vi.mock('../service/websocket', () => ({ wsService: { broadcast: vi.fn(), broadcastToUsers: vi.fn() } }));
vi.mock('../service/realtime-audience', () => ({ getDomainAudienceUserIds: vi.fn(async () => []) }));
vi.mock('../service/whois', async () => {
  const du = await import('../service/whois/domain-utils');
  return { syncDomainWhois: vi.fn(), queryWhois: vi.fn(), getRootDomain: du.getRootDomain, groupDomains: du.groupDomains };
});
vi.mock('../lib/domain-event-bus', () => ({ publishDomainEvent: vi.fn() }));
vi.mock('../service/renewalScheduler', () => ({ renewalRegistry: { getScheduler: () => null } }));
vi.mock('../lib/dns/providers', () => ({ dnsheGetWhois: vi.fn() }));
vi.mock('../lib/dns/DnsHelper', () => ({ createAdapter: () => ({}) }));

import domainsRouter from './domains';
import mcpAuditRouter from './mcp-audit';

const app = express();
app.use(express.json());
app.use('/api/domains', domainsRouter);
app.use('/api/mcp/audit', mcpAuditRouter);
let server: http.Server; let base = '';
const boot = async () => { server = http.createServer(app); await new Promise<void>((r) => server.listen(0, r)); base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port; };
const send = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text();
  return { status: res.status, json: (() => { try { return JSON.parse(t); } catch { return null; } })(), text: t };
};

describe('A3 备注限长 / A6 审计 CSV 转义', () => {
  it('PUT 400 字符被拒、200 字符通过、POST 创建未限长', async () => {
    await boot();
    try {
      const long = 'x'.repeat(400);
      const ok200 = 'y'.repeat(200);
      const put400 = await send('PUT', '/api/domains/1', { remark: long });
      const put200 = await send('PUT', '/api/domains/1', { remark: ok200 });
      const post400 = await send('POST', '/api/domains', { account_id: 5, name: 'b.com', remark: long });
      const batch400 = await send('POST', '/api/domains', { account_id: 5, domains: [{ name: 'c.com', remark: long }] });
      console.log('[A3] PUT 400 字符 →', put400.status, put400.json?.msg, '| PUT 200 字符 →', put200.status);
      console.log('[A3] POST 创建 400 字符 →', post400.status, JSON.stringify(post400.json).slice(0, 200), '| 批量创建 400 字符 →', batch400.status, JSON.stringify(batch400.json).slice(0, 200), '| 实际入库备注长度', JSON.stringify(S.created.map(c => (c.remark || '').length)));
      expect(put400.status).toBe(400);
      expect(put200.status).toBe(200);
    } finally { server.close(); }
  });

  it('MCP 审计 CSV 对 =cmd 公式与引号做转义', async () => {
    S.logs = [
      { id: 1, user_id: 2, auth_type: 'api_key', module: 'domain_management', action: '=cmd|\'/C calc\'!A0', resource_type: 'domain', resource_id: 'a,b', response_status: 'success', ip_address: '1.1.1.1', created_at: '2026-10-24 10:00:00' },
      { id: 2, user_id: 2, auth_type: 'api_key', module: 'm', action: 'list_domains', resource_type: null, resource_id: 'q"uote', response_status: null, ip_address: null, created_at: '2026-10-24 10:01:00' },
    ];
    await boot();
    try {
      const r = await send('GET', '/api/mcp/audit/export?format=csv');
      const csv = (r.json?.data?.data ?? '') as string;
      console.log('[A6] CSV:\n' + csv);
      expect(csv).toContain("'=cmd");
      expect(csv).toContain('"a,b"');
    } finally { server.close(); }
  });
});