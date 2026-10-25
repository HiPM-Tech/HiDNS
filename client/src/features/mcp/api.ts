import { ensureOk, expectData, http } from '../../lib/http';

export interface McpKeyRow {
  id: number;
  api_key: string;
  description: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface McpOAuthClientRow {
  id: number;
  client_id: string;
  app_name: string;
  redirect_uris: string;
  scope?: string | null;
  expires_at?: string | null;
  created_at: string;
  updated_at?: string;
}

export interface McpAuditRow {
  id: number;
  user_id?: number;
  username?: string | null;
  action: string;
  resource?: string | null;
  status?: string;
  created_at?: string;
  details?: string | null;
}

export interface McpStatus {
  enabled?: boolean;
  config?: { enabled?: boolean; updated_at?: string };
}

export const mcpApi = {
  status: async (): Promise<McpStatus> => expectData(http.get<McpStatus>('/mcp/status')),
  globalConfig: async (): Promise<{ enabled?: boolean; updated_at?: string }> => expectData(http.get<{ enabled?: boolean }>('/mcp/config')),
  setGlobalEnabled: async (enabled: boolean) => ensureOk(await http.put<null>('/mcp/config', { enabled })),

  keys: async (): Promise<McpKeyRow[]> => {
    const data = await expectData(http.get<McpKeyRow[] | { items?: McpKeyRow[] }>('/mcp/api-keys'));
    return Array.isArray(data) ? data : (data?.items ?? []);
  },
  createKey: async (payload: { description: string; expires_at?: string | null }) =>
    expectData(http.postOk<{ api_key?: string; keyData?: McpKeyRow }>('/mcp/api-keys', payload)),
  revokeKey: async (id: number) => ensureOk(await http.post<null>(`/mcp/api-keys/${id}/revoke`)),
  restoreKey: async (id: number) => ensureOk(await http.post<null>(`/mcp/api-keys/${id}/restore`)),
  deleteKey: async (id: number) => ensureOk(await http.delete<null>(`/mcp/api-keys/${id}`)),

  oauthClients: async (): Promise<McpOAuthClientRow[]> => {
    const data = await expectData(http.get<McpOAuthClientRow[] | { items?: McpOAuthClientRow[] }>('/mcp/oauth/clients'));
    return Array.isArray(data) ? data : (data?.items ?? []);
  },
  createOAuthClient: async (payload: { app_name: string; redirect_uris: string[]; scope?: string }) =>
    expectData(http.postOk<{ client_id: string; client_secret: string }>('/mcp/oauth/clients', payload)),
  deleteOAuthClient: async (clientId: string) => ensureOk(await http.delete<null>(`/mcp/oauth/clients/${encodeURIComponent(clientId)}`)),
  updateOAuthScope: async (clientId: string, scope: string) =>
    ensureOk(await http.put<null>(`/mcp/oauth/clients/${encodeURIComponent(clientId)}/scope`, { scope })),

  auditLogs: async (query: { page: number; pageSize: number; action?: string; startDate?: string; endDate?: string }): Promise<{ logs: McpAuditRow[]; total: number }> => {
    const data = await expectData(http.get<{ logs?: McpAuditRow[]; total?: number }>('/mcp/audit-logs', { query }));
    return { logs: data.logs ?? [], total: data.total ?? 0 };
  },
};

/** MCP 权限模块与级别（与后端 scope 串一致：module:level,module:level） */
export const SCOPE_MODULES = [
  { key: 'ns_monitor', label: 'NS 监控' },
  { key: 'domain_management', label: '域名管理' },
  { key: 'renewal_management', label: '续期管理' },
  { key: 'log_query', label: '日志查询' },
  { key: 'service_monitor', label: '服务监控' },
] as const;

export const SCOPE_LEVELS = [
  { value: 'disabled', label: '禁用' },
  { value: 'read', label: '只读' },
  { value: 'write', label: '读写' },
] as const;

export function parseScope(scope?: string | null): Record<string, string> {
  if (!scope) return {};
  const text = scope.trim().startsWith('"') ? (() => { try { return JSON.parse(scope) as string; } catch { return scope; } })() : scope;
  const result: Record<string, string> = {};
  for (const item of String(text).split(',').map((part) => part.trim()).filter(Boolean)) {
    const [module, level] = item.split(':');
    if (module && level) result[module] = level;
  }
  return result;
}

export function serializeScope(perms: Record<string, string>): string {
  return Object.entries(perms)
    .filter(([module, level]) => level && level !== 'disabled' && SCOPE_MODULES.some((item) => item.key === module))
    .map(([module, level]) => module + ':' + level)
    .join(', ');
}

/** 客户端实际可用权限的可读描述（空 scope 表示全部禁用） */
export function describeScope(scope?: string | null): string {
  const perms = parseScope(scope);
  const active = SCOPE_MODULES.filter((item) => perms[item.key] && perms[item.key] !== 'disabled');
  if (active.length === 0) return '未授权任何模块';
  return active.map((item) => item.label + '：' + (perms[item.key] === 'write' ? '读写' : '只读')).join(' · ');
}
