import { http, type ApiEnvelope } from '../../lib/http';

export interface NsMonitorRow {
  id: number;
  domain_id: number;
  domain_name: string;
  expected_ns: string;
  enabled: boolean | number;
  notify_email?: boolean | number;
  notify_channels?: boolean | number;
  current_ns?: string | null;
  status?: string;
  last_check_at?: string | null;
  alert_count?: number;
}

export interface NsCheckResult {
  current_ns: string[];
  expected_ns: string[];
  status: string;
}

export interface NsResolveResult {
  domain: string;
  nsRecords: string[];
  encryptedNs: string[];
  plainNs: string[];
  isPoisoned: boolean;
  recommendedNs: string[];
}

export interface AvailableDomain {
  id: number;
  name: string;
  account_id: number;
}

/**
 * ns-monitor 路由使用 `{ success, data }` 信封（与其他路由的 `{ code, data, msg }` 不一致），
 * 这里单独适配，避免上层再写一遍分支。
 */
function unwrapNs<T>(envelope: ApiEnvelope<T> & { success?: boolean }): T {
  if (envelope.success === false || envelope.code !== 0) {
    throw new Error(envelope.msg || '请求失败');
  }
  return envelope.data;
}

export async function listNsMonitors(query: { page: number; pageSize: number; keyword?: string }): Promise<{ list: NsMonitorRow[]; total: number }> {
  const envelope = await http.get<{ list?: NsMonitorRow[]; total?: number }>('/ns-monitor', { query });
  const data = unwrapNs(envelope) ?? {};
  return { list: data.list ?? [], total: data.total ?? 0 };
}

export async function listAvailableDomains(): Promise<AvailableDomain[]> {
  const envelope = await http.get<AvailableDomain[]>('/ns-monitor/available-domains');
  const data = unwrapNs(envelope);
  return Array.isArray(data) ? data : [];
}

export async function addNsMonitor(payload: {
  domain_name: string;
  expected_ns: string;
  enabled: boolean;
  notify_email: boolean;
  notify_channels: boolean;
}): Promise<{ id: number }> {
  const envelope = await http.postOk<{ id: number }>('/ns-monitor', payload);
  return unwrapNs(envelope);
}

export async function updateNsMonitor(id: number, payload: { expected_ns?: string; enabled?: boolean }): Promise<void> {
  await unwrapNs(await http.putOk<null>(`/ns-monitor/${id}`, payload));
}

export async function deleteNsMonitor(id: number): Promise<void> {
  await unwrapNs(await http.deleteOk<null>(`/ns-monitor/${id}`));
}

export async function checkNsRecord(domainName: string): Promise<NsCheckResult> {
  const envelope = await http.postOk<NsCheckResult>('/ns-monitor/check', { domain_name: domainName });
  return unwrapNs(envelope);
}

export async function resolveNs(domain: string): Promise<NsResolveResult> {
  const envelope = await http.postOk<NsResolveResult>('/ns-monitor/resolve-ns', { domain });
  return unwrapNs(envelope);
}
