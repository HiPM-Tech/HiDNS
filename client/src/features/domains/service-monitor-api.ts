import { ensureOk, http } from '../../lib/http';

export type MonitorType = 'ssl_certificate' | 'endpoint' | 'dns_failover';

export interface MonitorRow {
  enabled?: boolean;
  id: number;
  name: string;
  monitor_type: MonitorType;
  target: string;
  check_interval?: number;
  notify_on_failure?: boolean;
  notify_on_recovery?: boolean;
  domain_id?: number | null;
  parent_id?: number | null;
  config?: Record<string, unknown>;
  status?: string;
  last_check_at?: string | null;
  response_time?: number | null;
  result_data?: unknown;
  created_at?: string;
}

export interface AvailableDomain {
  id: number;
  name: string;
  account_type?: string;
  account_name?: string;
}

export interface MonitorPayload {
  name: string;
  monitor_type: MonitorType;
  target: string;
  check_interval?: number;
  notify_on_failure?: boolean;
  notify_on_recovery?: boolean;
  domain_id?: number;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

async function unwrap<T>(promise: Promise<import('../../lib/http').ApiEnvelope<T>>): Promise<T> {
  const envelope = await promise;
  if (envelope.code !== 0) throw new Error(envelope.msg || '请求失败');
  return envelope.data;
}

export const serviceMonitorApi = {
  list: async (query: { page: number; pageSize: number; type?: MonitorType; keyword?: string }): Promise<{ list: MonitorRow[]; total: number }> => {
    const data = await unwrap(http.get<{ list?: MonitorRow[]; total?: number }>('/servicemonitor', { query }));
    return { list: data.list ?? [], total: data.total ?? 0 };
  },
  create: async (payload: MonitorPayload) => ensureOk(await http.post<{ id: number }>('/servicemonitor', payload)),
  update: async (id: number, payload: Partial<MonitorPayload>) => ensureOk(await http.put<null>(`/servicemonitor/${id}`, payload)),
  remove: async (id: number) => ensureOk(await http.delete<null>(`/servicemonitor/${id}`)),
  check: async (id: number): Promise<Record<string, unknown>> =>
    unwrap(http.post<Record<string, unknown>>(`/servicemonitor/${id}/check`, undefined, { timeoutMs: 60_000 })),
  availableDomains: async (): Promise<AvailableDomain[]> => {
    const data = await unwrap(http.get<AvailableDomain[]>('/servicemonitor/available-domains'));
    return Array.isArray(data) ? data : [];
  },
};

export const MONITOR_TYPE_LABEL: Record<MonitorType, string> = {
  ssl_certificate: 'SSL 证书',
  endpoint: '端点探测',
  dns_failover: 'DNS 故障转移',
};

export function monitorStatus(row: MonitorRow): { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' } {
  switch (row.status) {
    // 后端 performCheck 返回 ok/warning/error，历史代码只映射 healthy/degraded/down，
    // 导致「检测成功」在列表里仍显示「未检测」（C 端细节轮 P1）。
    case 'ok':
    case 'healthy': return { label: '正常', variant: 'success' };
    case 'warning':
    case 'degraded': return { label: '异常', variant: 'warning' };
    case 'down': return { label: '不可用', variant: 'destructive' };
    case 'error': return { label: '检测失败', variant: 'destructive' };
    default: return { label: '未检测', variant: 'secondary' };
  }
}

/** SSL 证书剩余天数：优先取检测结果，其次用 target 无法推导，返回 null */
export function sslDaysLeft(row: MonitorRow): number | null {
  const data = row.result_data as { daysUntilExpiry?: number } | null | undefined;
  const days = data?.daysUntilExpiry;
  return typeof days === 'number' ? days : null;
}
