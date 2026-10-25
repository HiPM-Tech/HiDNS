import { http } from '../../lib/http';

export interface AuditLogRow {
  id: number;
  user_id?: number | null;
  username?: string | null;
  nickname?: string | null;
  action: string;
  domain?: string | null;
  data?: string | null;
  created_at?: string;
}

export interface AuditFilters {
  domain?: string;
  action?: string;
  userId?: number;
  startDate?: string;
  endDate?: string;
}

export interface AuditQuery extends AuditFilters {
  page: number;
  pageSize: number;
}

export async function listAuditLogs(query: AuditQuery): Promise<{ total: number; list: AuditLogRow[] }> {
  const envelope = await http.get<{ total?: number; list?: AuditLogRow[] }>('/audit/logs', {
    query: {
      page: query.page,
      pageSize: query.pageSize,
      domain: query.domain || undefined,
      action: query.action || undefined,
      userId: query.userId,
      startDate: query.startDate || undefined,
      endDate: query.endDate || undefined,
    },
  });
  const data = envelope.data ?? {};
  return { total: data.total ?? 0, list: data.list ?? [] };
}

/** 导出下载地址（CSV / JSON），过滤条件与列表一致 */
export function auditExportUrl(format: 'csv' | 'json', filters: AuditFilters): string {
  const base = import.meta.env.VITE_API_URL as string | undefined;
  const prefix = base ? base.replace(/\/$/, '') : `${window.location.protocol}//${window.location.host}/api`;
  const params = new URLSearchParams();
  if (filters.domain) params.set('domain', filters.domain);
  if (filters.action) params.set('action', filters.action);
  if (filters.userId !== undefined) params.set('userId', String(filters.userId));
  if (filters.startDate) params.set('startDate', filters.startDate);
  if (filters.endDate) params.set('endDate', filters.endDate);
  const query = params.toString();
  return `${prefix}/audit/export/${format}${query ? `?${query}` : ''}`;
}
