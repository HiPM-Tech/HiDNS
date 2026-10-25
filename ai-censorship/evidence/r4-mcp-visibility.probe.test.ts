import { describe, it, expect, vi } from 'vitest';

const S = vi.hoisted(() => ({
  rows: [] as any[],
  accessible: [] as any[],
  enabledCalls: [] as any[],
  recordCalls: [] as any[],
  created: [] as any[],
}));

vi.mock('../db/bal/business-adapter', () => ({
  McpOperations: {
    validateApiKey: vi.fn(async () => ({ id: 9, user_id: 42, description: 'member key' })),
    validateAccessToken: vi.fn(async () => null),
    updateApiKeyLastUsed: vi.fn(async () => undefined),
  },
  UserOperations: { getById: vi.fn(async () => ({ id: 42, role_level: 1 })) },
  TeamOperations: { getTeamIdsByUserId: vi.fn(async () => []) },
  DomainOperations: {
    getAccessibleDomains: vi.fn(async () => S.accessible),
    getAllForSuperAdminWithPagination: vi.fn(async (o: any) => {
      const start = ((o.page ?? 1) - 1) * (o.pageSize ?? 50);
      const list = S.rows.slice(start, start + (o.pageSize ?? 50));
      return { list, total: S.rows.length };
    }),
    getAllForSuperAdmin: vi.fn(async () => S.rows),
    getById: vi.fn(async (id: number) => S.rows.find((r) => r.id === id)),
    setEnabled: vi.fn(async (id: number, en: number) => { S.enabledCalls.push([id, en]); }),
  },
  RenewableDomainOperations: { getAllEnabled: vi.fn(async () => {
    const soon = new Date(Date.now() + 10 * 86400_000).toISOString();
    return [
      { id: 1, account_id: 5, full_domain: 'shared.com', expires_at: soon },
      { id: 2, account_id: 5, full_domain: 'secret-same-account.com', expires_at: soon },
      { id: 3, account_id: 9, full_domain: 'other-tenant.com', expires_at: soon },
    ];
  }) },
  ServiceMonitorOperations: {}, NSMonitorOperations: {}, RecordOperations: {}, UserPreferencesOperations: {}, AuditExportOperations: {},
  OAuthOperations: {},
}));

vi.mock('../service/mcp-permission', () => ({
  validateToolPermission: vi.fn(async () => undefined),
  logMcpAction: vi.fn(async () => undefined),
  getModuleByToolName: vi.fn(() => 'domain_management'),
}));

vi.mock('../service/dns-provider-service', () => ({
  DnsProviderService: {
    getRecords: vi.fn(async (domainId: number) => { S.recordCalls.push(['getRecords', domainId]); return { total: 1, list: [{ RecordId: 'r1', Name: 'www', Value: '1.1.1.1' }] }; }),
    createRecord: vi.fn(async (domainId: number) => { S.created.push(['createRecord', domainId]); return 'new-rec-id'; }),
    getLines: vi.fn(async () => ['0']),
    getRecordInfo: vi.fn(async () => ({})),
    updateRecord: vi.fn(async () => true),
    deleteRecord: vi.fn(async () => true),
  },
}));

vi.mock('../lib/domain-event-bus', () => ({ hasDomainEventSubscribers: () => false, publishDomainEvent: vi.fn() }));
vi.mock('../service/whois/checker', () => ({ checkWhoisForDomain: vi.fn(async () => null) }));
vi.mock('../lib/dns/ns-lookup', () => ({ resolveNsRecords: vi.fn(async () => []), validateNsRecords: vi.fn(() => ({ valid: true })) }));

import { registerTools } from './tools';

const handlers: Record<string, any> = {};
const fakeServer: any = { tool: (name: string, _d: string, _s: any, handler: any) => { handlers[name] = handler; } };
registerTools(fakeServer);

const seed = () => {
  // 超管可见 1,2,3；member 42 只可见 1（account 5）
  S.rows = [
    { id: 1, name: 'shared.com', account_id: 5, enabled: 1, record_count: 1 },
    { id: 2, name: 'super-private.com', account_id: 5, enabled: 1, record_count: 0 },
    { id: 3, name: 'other-tenant.com', account_id: 9, enabled: 1, record_count: 0 },
  ];
  S.accessible = [{ id: 1, name: 'shared.com', account_id: 5 }];
  S.enabledCalls = []; S.recordCalls = []; S.created = [];
};

const text = (r: any) => r?.content?.[0]?.text ?? '';

describe('MCP 可见性（member key）', () => {
  it('A1-1 list_domains 只返回自己可见的域名', async () => {
    seed();
    const r = await handlers['list_domains']({ apiKey: 'k' });
    const parsed = JSON.parse(text(r));
    const names = parsed.domains.map((d: any) => d.name);
    console.log('[A1-1] list_domains →', JSON.stringify(names), 'total', parsed.total);
    expect(names).toEqual(['shared.com']);
  });

  it('A1-2 get_domain_info 越权返回 not found', async () => {
    seed();
    const own = await handlers['get_domain_info']({ apiKey: 'k', domainId: 1 });
    const other = await handlers['get_domain_info']({ apiKey: 'k', domainId: 3 });
    console.log('[A1-2] own →', text(own).slice(0, 40).replace(/\n/g, ' '), '| other →', text(other).slice(0, 60));
    expect(text(other)).toContain('not found');
  });

  it('A1-3 get_renewable_domains 过滤其他租户账号', async () => {
    seed();
    const r = await handlers['get_renewable_domains']({ apiKey: 'k' });
    const parsed = JSON.parse(text(r));
    console.log('[A1-3] raw →', text(r).slice(0, 400).replace(/\n/g, ' '));
    const names = (parsed.renewable_domains ?? []).map((d: any) => d.full_domain ?? d.domain);
    console.log('[A1-3] renewable →', JSON.stringify(names));
    expect(names).not.toContain('other-tenant.com');
    expect(names).toContain('secret-same-account.com'); // 账号级过滤：同账号但未授权的域名仍在列表里
  });

  it('NEW-1 list_domains_filtered 仍然全租户可见', async () => {
    seed();
    const r = await handlers['list_domains_filtered']({ apiKey: 'k' });
    const parsed = JSON.parse(text(r));
    const names = parsed.domains.map((d: any) => d.name);
    console.log('[NEW-1] list_domains_filtered →', JSON.stringify(names), 'total', parsed.total);
    expect(names).toContain('other-tenant.com');
  });

  it('NEW-2 update_domain_status 可关闭他租户域名', async () => {
    seed();
    const r = await handlers['update_domain_status']({ apiKey: 'k', domainId: 3, enabled: false });
    console.log('[NEW-2] update_domain_status(3,false) →', text(r).slice(0, 60), '| setEnabled 调用', JSON.stringify(S.enabledCalls));
    expect(S.enabledCalls).toEqual([[3, 0]]);
  });

  it('NEW-3 list_domain_records / create_dns_record 越权读写他租户记录', async () => {
    seed();
    const list = await handlers['list_domain_records']({ apiKey: 'k', domainId: 3 });
    const created = await handlers['create_dns_record']({ apiKey: 'k', domainId: 3, name: 'pwn', type: 'A', content: '6.6.6.6' });
    console.log('[NEW-3] list_domain_records(3) →', text(list).slice(0, 50).replace(/\n/g, ' '), '| create_dns_record(3) →', text(created).slice(0, 40), '| 调用', JSON.stringify(S.recordCalls), JSON.stringify(S.created));
    expect(S.recordCalls).toEqual([['getRecords', 3]]);
    expect(S.created).toEqual([['createRecord', 3]]);
  });

  it('NEW-4 list_domains 非超管分页在过滤后基于单页重算 total', async () => {
    seed();
    // 全局列表 pageSize=1：第 1 页是 shared.com（可见），第 2 页是 super-private.com（不可见）
    const p2 = JSON.parse(text(await handlers['list_domains']({ apiKey: 'k', page: 2, pageSize: 1 })));
    console.log('[NEW-4] page2/pageSize1 → domains', JSON.stringify(p2.domains.map((d: any) => d.name)), 'total', p2.total, 'totalPages', p2.totalPages);
    expect(p2.totalPages).toBe(1); // 全局共 3 条 → 真实应为 1 页（可见 1 条），但此处 totalPages 来自单页可见数
  });
});