/**
 * HiDNS 对抗性业务测试探针（IDN / 分组 / 权限 / 输入边界）
 * 运行：
 *   cd /workspace/HiDNS/server
 *   cp ../ai-censorship/evidence/adversarial-probe.domains.test.ts src/routes/__probe__/adv.test.ts
 *   ./node_modules/.bin/vitest run src/routes/__probe__/adv.test.ts
 * 说明：全部走内存 mock（无 DB、无上游），只验证路由层的判定逻辑。
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';

const S = vi.hoisted(() => ({
  user: { userId: 7, role: 2 },
  token: false,
  allowed: [1] as number[] | undefined,
  rows: [] as any[],
  perms: [] as any[],
  hasRules: false,
  created: [] as string[],
  added: [] as any[],
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = S.user;
    if (S.token) req.tokenPayload = { userId: S.user.userId, tokenId: 3, maxRole: S.user.role, allowedDomains: S.allowed };
    next();
  },
  // 与 middleware/auth.ts:147-194 逐字对齐
  requireTokenDomainPermission: (param: string = 'id') => (req: any, res: any, next: any) => {
    const tp = req.tokenPayload;
    if (!tp || tp.allowedDomains === null || tp.allowedDomains === undefined) return next();
    if (tp.allowedDomains.length === 0) return next();
    const id = req.params[param] ? parseInt(req.params[param], 10) : req.body.domain_id;
    if (!id || isNaN(id)) return res.status(403).json({ code: 403, msg: 'Domain ID is required for API token access' });
    if (!tp.allowedDomains.includes(id)) return res.status(403).json({ code: 403, msg: 'API token does not have permission to access this domain' });
    return next();
  },
  requireDomainPermission: () => (_r: any, _s: any, n: any) => n(),
  adminOnly: (_r: any, _s: any, n: any) => n(),
  noTokenAuth: () => (_r: any, _s: any, n: any) => n(),
  requireJwtAuth: () => [(_r: any, _s: any, n: any) => n()],
}));

vi.mock('../../db/bal/business-adapter', () => ({
  DomainOperations: {
    getAllForSuperAdmin: vi.fn(async () => S.rows),
    getAll: vi.fn(async () => S.rows),
    getAllForSuperAdminWithPagination: vi.fn(async (o: any) => {
      let rows = S.rows;
      // 复刻 domain-query-builder.ts:243-257 的 apex/subdomain（点数）口径
      if (o.domainType === 'apex') rows = rows.filter((r: any) => !/\..*\./.test(r.name));
      if (o.domainType === 'subdomain') rows = rows.filter((r: any) => /\..*\./.test(r.name));
      const s = (o.page - 1) * o.pageSize;
      return { list: rows.slice(s, s + o.pageSize), total: rows.length };
    }),
    getAccessibleDomains: vi.fn(async () => S.rows),
    getAccessibleDomainsWithPagination: vi.fn(async (o: any) => { const s = (o.page - 1) * o.pageSize; return { list: S.rows.slice(s, s + o.pageSize), total: S.rows.length }; }),
    getByIds: vi.fn(async (ids: number[]) => S.rows.filter((r) => ids.includes(r.id))),
    getById: vi.fn(async (id: number) => S.rows.find((r) => r.id === id)),
    getByName: vi.fn(async (name: string) => S.rows.find((r) => r.name === name)),
    getByAccountIdAndName: vi.fn(async (_a: number, name: string) => S.rows.find((r) => r.name === name)),
    create: vi.fn(async (d: any) => { S.created.push(d.name); return S.created.length; }),
    updateThirdIdAndRecordCount: vi.fn(async () => undefined),
    updateRecordCount: vi.fn(async () => undefined),
    setEnabled: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  },
  DnsAccountOperations: {
    getById: vi.fn(async () => ({ id: 5, type: 'cloudflare', config: '{}', created_by: 7, enabled: 1 })),
    getCreatedBy: vi.fn(async () => 7),
    getAll: vi.fn(async () => []),
  },
  DomainPermissionOperations: {
    hasRules: vi.fn(async () => S.hasRules),
    getByDomainAndUser: vi.fn(async () => S.perms),
    getByDomainAndTeamMember: vi.fn(async () => []),
    getByDomainId: vi.fn(async () => []),
  },
  TeamOperations: { getTeamIdsByUserId: vi.fn(async () => []), getMembers: vi.fn(async () => []), isMember: vi.fn(async () => false) },
  UserOperations: { getAll: vi.fn(async () => []) },
  SystemCacheOperations: { get: vi.fn(async () => undefined), set: vi.fn(async () => undefined) },
  RenewableDomainOperations: { getById: vi.fn(async () => undefined) },
  NSMonitorOperations: { getUserMonitors: vi.fn(async () => []) },
  UserPreferencesOperations: { get: vi.fn(async () => undefined) },
  WhoisOperations: {},
  GroupedDomainsCacheOperations: { get: vi.fn(async () => null), set: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) },
}));

const adapter = {
  getDomainRecords: vi.fn(async () => ({ total: 1, list: [{ RecordId: 'r1', Name: 'www', Type: 'A', Value: '1.1.1.1', TTL: 600, Status: 1, Line: '0' }] })),
  getDomainRecordInfo: vi.fn(async () => ({ RecordId: 'r1', Name: 'www', Type: 'A', Value: '1.1.1.1' })),
  addDomainRecord: vi.fn(async (...a: any[]) => { S.added.push(a); return 'rid'; }),
};
vi.mock('../../lib/dns/DnsHelper', () => ({ createAdapter: () => adapter }));
vi.mock('../../service/groupedCacheJob', () => ({
  getCacheVersion: vi.fn(async () => 1), setCachedGroupedData: vi.fn(async () => undefined),
  getCachedGroupedData: vi.fn(async () => null), bumpCacheVersion: vi.fn(async () => 1), submitGroupedCacheUpdate: vi.fn(),
}));
vi.mock('../../service/audit', () => ({ logAuditOperation: vi.fn(async () => undefined) }));
vi.mock('../../service/websocket', () => ({ wsService: { broadcast: vi.fn(), broadcastToUsers: vi.fn() } }));
vi.mock('../../service/realtime-audience', () => ({ getDomainAudienceUserIds: vi.fn(async () => []) }));
vi.mock('../../service/whois', async () => {
  const du = await import('../../service/whois/domain-utils');
  return { syncDomainWhois: vi.fn(async () => undefined), queryWhois: vi.fn(async () => ({ domain: 'x', raw: '' })), getRootDomain: du.getRootDomain, groupDomains: du.groupDomains };
});
vi.mock('../../lib/domain-event-bus', () => ({ publishDomainEvent: vi.fn() }));
vi.mock('../../service/renewalScheduler', () => ({ renewalRegistry: { getScheduler: () => null } }));
vi.mock('../../lib/dns/providers', () => ({ dnsheGetWhois: vi.fn(async () => null) }));
vi.mock('../../workflow/publish', () => ({ hasWorkflowSubscribers: () => false, publishRecordEvent: vi.fn() }));
vi.mock('../../lib/dns/record-lookup', () => ({ findRecordMeta: vi.fn(async () => undefined) }));

import domainsRouter from '../domains';
import recordsRouter from '../records';

const app = express();
app.use(express.json());
app.use('/api/domains/:domainId/records', recordsRouter);
app.use('/api/domains', domainsRouter);
let server: http.Server; let base = '';
const boot = async () => { server = http.createServer(app); await new Promise<void>((r) => server.listen(0, r)); base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port; };
const J = async (p: string, init?: any) => { const res = await fetch(base + p, init); const t = await res.text(); return { status: res.status, text: t, json: (() => { try { return JSON.parse(t); } catch { return null; } })() }; };
const post = (p: string, body: unknown) => J(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const IDN_APEX = 'xn--fsqu00a.xn--55qx5d.cn';   // 例子.公司.cn
const DAD = 'xn--fsqu00a.xn--fiqs8s';            // 例子.中国

const seed = () => {
  S.rows = [
    { id: 1, name: 'a.com', account_id: 5, enabled: 1, record_count: 0, remark: null, third_id: 'a1' },
    { id: 2, name: 'sub.a.com', account_id: 5, enabled: 1, record_count: 0, remark: null, third_id: 'a2' },
    { id: 3, name: IDN_APEX, account_id: 5, enabled: 1, record_count: 0, remark: null, third_id: 'a3' },
    { id: 4, name: 'www.' + IDN_APEX, account_id: 5, enabled: 1, record_count: 0, remark: null, third_id: 'a4' },
    { id: 5, name: DAD, account_id: 5, enabled: 1, record_count: 0, remark: null, third_id: 'a5' },
    { id: 6, name: 'c.dpdns.org', account_id: 5, enabled: 1, record_count: 0, remark: null, third_id: 'a6' },
  ];
};

describe('对抗性探针', () => {
  // P1-1：Token 白名单不约束读（records 列表 + zone 导出）
  it('P1-1 token 白名单=[1] 读取域名 2 的记录与 zone', async () => {
    seed(); S.token = true; S.allowed = [1]; await boot();
    try {
      const list = await J('/api/domains/2/records');
      const zone = await J('/api/domains/2/records/export/zone');
      const write = await post('/api/domains/2/records', { name: 'www', type: 'A', value: '2.2.2.2' });
      console.log('[P1-1] GET records →', list.status, '| export/zone →', zone.status, '| POST record →', write.status);
      expect(list.status).toBe(200);   // 期望 403（与写口径一致）
      expect(zone.status).toBe(200);   // 期望 403
      expect(write.status).toBe(403);  // 写是被拦的，形成读写不对称
    } finally { server.close(); S.token = false; }
  });

  // P1-2：文档化的 GET /domains/whois 被 /:id 遮蔽；其 accountId 分支无归属校验
  it('P1-2 GET /domains/whois 不可达（被 /:id 抢占）', async () => {
    seed(); S.user = { userId: 8, role: 1 }; await boot();
    try {
      const wh = await J('/api/domains/whois?domain=a.com&accountId=5');
      const num = await J('/api/domains/1');
      console.log('[P1-2] GET /domains/whois →', wh.status, wh.json && wh.json.msg, '| GET /domains/1 →', num.status, num.json && num.json.msg);
      expect(wh.json && wh.json.msg).toBe('Domain not found or no permission'); // 走的是 /:id，id='whois' → NaN → 0
    } finally { server.close(); S.user = { userId: 7, role: 2 }; }
  });

  // P1-3：grouped 下 IDN 关键词搜不到
  it('P1-3 grouped 模式中文关键词恒空', async () => {
    seed(); await boot();
    try {
      const g = await J('/api/domains?grouped=true&virtual_groups=true&keyword=' + encodeURIComponent('例子'));
      const n = await J('/api/domains?keyword=' + encodeURIComponent('例子'));
      console.log('[P1-3] grouped keyword=例子 →', (g.json.data.list || []).length, '条 | 非分组 →', (n.json.data.list || []).length, '条');
      expect((g.json.data.list || []).length).toBe(0);
      expect((n.json.data.list || []).length).toBeGreaterThan(0);
    } finally { server.close(); }
  });

  // P1-4：domain_type 口径与 getRootDomain 冲突
  it('P1-4 domain_type=apex 漏掉中文顶域 / dpdns 顶域', async () => {
    seed(); S.user = { userId: 1, role: 3 }; await boot();
    try {
      const apex = await J('/api/domains?domain_type=apex');
      const sub = await J('/api/domains?domain_type=subdomain');
      const names = (r: any) => (r.json.data.list || []).map((d: any) => d.name);
      console.log('[P1-4] apex →', JSON.stringify(names(apex)), '| subdomain →', JSON.stringify(names(sub)));
      // 顶层响应把 Punycode 转成 Unicode 显示，故按 Unicode 断言
      expect(names(apex)).not.toContain('例子.公司.cn');   // 期望包含（PSL 判定它是可注册域）
      expect(names(sub)).toContain('例子.公司.cn');        // 现状：被当成子域
      expect(names(sub)).toContain('c.dpdns.org');
    } finally { server.close(); S.user = { userId: 7, role: 2 }; }
  });

  // P1-5：POST /domains 零格式校验
  it('P1-5 POST /domains 接受非法域名', async () => {
    seed(); S.created = []; await boot();
    try {
      for (const name of ['a..b', '-bad.com', 'bad_name!.com', 'xn--zzzz', 'example.com..']) {
        const r = await post('/api/domains', { account_id: 5, name });
        console.log('[P1-5] POST /domains', JSON.stringify(name), '→', r.status);
      }
      console.log('[P1-5] 实际入库:', JSON.stringify(S.created));
      expect(S.created.length).toBeGreaterThanOrEqual(5);
    } finally { server.close(); }
  });

  // P1-6：POST /records 不校验 name / ttl / mx
  it('P1-6 记录名、TTL、MX 优先级无校验', async () => {
    seed(); S.added = []; await boot();
    try {
      const bad = [
        { name: 'a'.repeat(64), type: 'A', value: '1.1.1.1' },
        { name: ' ', type: 'A', value: '1.1.1.1' },
        { name: 'www', type: 'A', value: '1.1.1.1', ttl: -1 },
        { name: 'www', type: 'MX', value: 'mail.a.com' },
        { name: 'www', type: 'MX', value: 'mail.a.com', mx: 99999 },
      ];
      for (const b of bad) console.log('[P1-6]', JSON.stringify(b), '→', (await post('/api/domains/1/records', b)).status);
      console.log('[P1-6] 直发上游的参数:', JSON.stringify(S.added));
      expect(S.added.length).toBe(5);
    } finally { server.close(); }
  });

  // P2-2：can_write 与真实写不一致
  it('P2-2 子域白名单下 can_write 仍为 true', async () => {
    seed(); S.user = { userId: 8, role: 1 }; S.hasRules = true; S.perms = [{ permission: 'write', sub: 'www' }]; await boot();
    try {
      const list = await J('/api/domains?pageSize=10');
      const flags = (list.json.data.list || []).map((d: any) => ({ id: d.id, can_write: d.can_write }));
      const w1 = await post('/api/domains/1/records', { name: 'www', type: 'A', value: '1.1.1.1' });
      const w2 = await post('/api/domains/1/records', { name: '@', type: 'A', value: '1.1.1.1' });
      console.log('[P2-2] can_write:', JSON.stringify(flags), '| 写 www →', w1.status, '| 写 @ →', w2.status);
      expect(flags.every((f: any) => f.can_write === true)).toBe(true);
      expect(w2.status).toBe(403);
    } finally { server.close(); S.hasRules = false; S.perms = []; S.user = { userId: 7, role: 2 }; }
  });

  // P2-3：grouped 分页边界
  it('P2-3 grouped 下 pageSize 无上限 / page 越界静默夹取', async () => {
    seed(); await boot();
    try {
      const big = await J('/api/domains?grouped=true&virtual_groups=true&pageSize=100000');
      const over = await J('/api/domains?grouped=true&virtual_groups=true&pageSize=1&page=999');
      const sci = await J('/api/domains?page=999999999999999999999');
      console.log('[P2-3] pageSize 回显', big.json.data.pageSize, '| page=999 → page', over.json.data.page, '/ totalPages', over.json.data.totalPages, '| page 巨大值回显', sci.json.data.page);
      expect(big.json.data.pageSize).toBe(100000);   // 文档 1000 上限
      expect(over.json.data.page).toBe(over.json.data.totalPages); // 静默夹到末页
      expect(String(sci.json.data.page)).toBe('1e+21');
    } finally { server.close(); }
  });

  // P2-5：Token/format=array + grouped 静默降级
  it('P2-5 token + grouped=true 静默不分组且忽略 pageSize', async () => {
    seed(); S.token = true; S.allowed = [1, 2, 3]; await boot();
    try {
      const r = await J('/api/domains?grouped=true&virtual_groups=true&pageSize=1');
      const data = r.json.data;
      console.log('[P2-5] token+grouped 返回', Array.isArray(data) ? '数组' : '对象', '长度', Array.isArray(data) ? data.length : 'n/a', '| 含组头', JSON.stringify(data).includes('group_header'));
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBe(3);        // pageSize=1 被忽略
      expect(JSON.stringify(data)).not.toContain('group_header');
    } finally { server.close(); S.token = false; }
  });

  // P2-6：batch 脏数据 500
  it('P2-6 batch records=[null] → 500 HTML', async () => {
    seed(); await boot();
    try {
      const r = await post('/api/domains/1/records/batch', { records: [null] });
      console.log('[P2-6] batch [null] →', r.status, r.text.slice(0, 60).replace(/\n/g, ' '));
      expect(r.status).toBe(500);
      expect(r.text).toContain('TypeError');
    } finally { server.close(); }
  });

  // P2-1：组头 groupName 保持 Punycode
  it('P2-1 group_header.groupName 未转 Unicode', async () => {
    seed(); await boot();
    try {
      const r = await J('/api/domains?grouped=true&virtual_groups=true&pageSize=50');
      const headers = (r.json.data.list || []).filter((i: any) => i._type === 'group_header');
      console.log('[P2-1] 组头:', JSON.stringify(headers.map((h: any) => h.groupName)), '| 子行名称:', JSON.stringify((r.json.data.list || []).filter((i: any) => i.name).map((i: any) => i.name)));
      expect(headers.some((h: any) => h.groupName.startsWith('xn--'))).toBe(true);
    } finally { server.close(); }
  });

  // 待核实：虚拟组 id 与父域 id 可能碰撞
  it('P2-x 复现虚拟组 id 与 -parentId 的取值域重叠', async () => {
    seed(); await boot();
    try {
      const r = await J('/api/domains?grouped=true&virtual_groups=true&pageSize=50');
      const ids = (r.json.data.list || []).filter((i: any) => i._type === 'group_header').map((h: any) => h.id);
      console.log('[P2-x] 虚拟组 id:', JSON.stringify(ids), '(父域 id ≥ 1,000,000 时 headerId=-parentId 会落进同一取值域)');
      expect(ids.every((id: number) => id < 0)).toBe(true);
    } finally { server.close(); }
  });
});