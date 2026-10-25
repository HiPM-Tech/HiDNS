import { http } from '../../lib/http';

export interface DnsRecordRow {
  id: string;
  name: string;
  type: string;
  value: string;
  line?: string | null;
  ttl: number;
  mx?: number | null;
  weight?: number | null;
  status: number;
  proxiable?: boolean | null;
  cloudflare?: { proxied?: boolean; proxiable?: boolean } | null;
  remark?: string | null;
  updated_at?: string | null;
}

export interface RecordLine {
  id: string;
  name: string;
}

export interface DomainDetail {
  id: number;
  name: string;
  account_id: number;
  record_count?: number;
}

export interface RecordQuery {
  page: number;
  pageSize: number;
  keyword?: string;
  type?: string;
  line?: string;
  status?: number;
}

export interface RecordPayload {
  name: string;
  type: string;
  value: string;
  line?: string;
  proxied?: boolean;
  ttl?: number;
  mx?: number;
  weight?: number;
  remark?: string;
}

export async function getDomainDetail(domainId: number): Promise<DomainDetail> {
  const envelope = await http.get<DomainDetail>(`/domains/${domainId}`);
  return envelope.data;
}

export async function listRecords(domainId: number, query: RecordQuery): Promise<{ total: number; list: DnsRecordRow[] }> {
  const envelope = await http.get<{ total?: number; list?: DnsRecordRow[] }>(`/domains/${domainId}/records`, {
    query: {
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword || undefined,
      type: query.type || undefined,
      line: query.line || undefined,
      status: query.status,
    },
  });
  const data = envelope.data ?? {};
  return { total: data.total ?? 0, list: data.list ?? [] };
}

export async function listRecordLines(domainId: number): Promise<RecordLine[]> {
  const envelope = await http.get<RecordLine[] | { list?: RecordLine[] }>(`/domains/${domainId}/lines`);
  const data = envelope.data;
  return Array.isArray(data) ? data : (data?.list ?? []);
}

export async function listRecordTypes(domainId: number): Promise<string[]> {
  const envelope = await http.get<string[] | { list?: string[] }>(`/domains/${domainId}/record-types`);
  const data = envelope.data;
  return Array.isArray(data) ? data : (data?.list ?? []);
}

export function createRecord(domainId: number, payload: RecordPayload) {
  return http.postOk<{ id: string }>(`/domains/${domainId}/records`, payload);
}

export function updateRecord(domainId: number, recordId: string, payload: RecordPayload) {
  return http.putOk<null>(`/domains/${domainId}/records/${encodeURIComponent(recordId)}`, payload);
}

export function deleteRecord(domainId: number, recordId: string) {
  return http.deleteOk<null>(`/domains/${domainId}/records/${encodeURIComponent(recordId)}`);
}

export function setRecordStatus(domainId: number, recordId: string, status: 0 | 1) {
  return http.putOk<null>(`/domains/${domainId}/records/${encodeURIComponent(recordId)}/status`, { status });
}

export interface BatchResultItem {
  /** 请求数组中的第几条（1 基），用于把失败行映射回用户输入的原始行号 */
  line: number;
  ok: boolean;
  recordId?: string;
  error?: string;
}

export interface BatchResult {
  total: number;
  results: BatchResultItem[];
  addedIds?: string[];
  errors?: string[];
}

export async function batchCreateRecords(domainId: number, records: RecordPayload[]): Promise<BatchResult> {
  const envelope = await http.postOk<BatchResult>(`/domains/${domainId}/records/batch`, { records });
  return envelope.data ?? { total: records.length, results: [] };
}

/** 导出 Zone：返回 BIND 文本与文件名（由前端触发下载，支持相对/完整名称） */
export async function exportZone(domainId: number, nameFormat: 'relative' | 'full' = 'relative'): Promise<{ content: string; filename: string }> {
  const envelope = await http.get<{ content: string; filename: string }>(`/domains/${domainId}/records/export/zone`, {
    query: { nameFormat },
  });
  return envelope.data;
}
