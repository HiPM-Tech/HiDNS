import { http } from '../../lib/http';

export interface RenewableDomainRow {
  id: number;
  name: string;
  full_domain?: string;
  account_id: number;
  account_name?: string;
  provider_type?: string;
  expires_at?: string | null;
  third_id?: string;
  remark?: string | null;
  enabled?: number | boolean;
  last_renewed_at?: string | null;
}

export interface RenewableQuery {
  page: number;
  pageSize: number;
  keyword?: string;
  account_id?: number;
  status?: 'enabled' | 'disabled' | 'all';
}

export interface ProviderDomainOption {
  name: string;
  third_id?: string;
  expires_at?: string | null;
}

async function unwrap<T>(promise: Promise<import('../../lib/http').ApiEnvelope<T>>): Promise<T> {
  const envelope = await promise;
  if (envelope.code !== 0) throw new Error(envelope.msg || '请求失败');
  return envelope.data;
}

export const renewalApi = {
  list: async (query: RenewableQuery): Promise<{ list: RenewableDomainRow[]; total: number }> => {
    const data = await unwrap(http.get<{ list?: RenewableDomainRow[]; total?: number }>('/domains/renewable-domains', {
      query: {
        page: query.page,
        pageSize: query.pageSize,
        keyword: query.keyword || undefined,
        account_id: query.account_id,
        status: query.status && query.status !== 'all' ? query.status : undefined,
      },
    }));
    return { list: data.list ?? [], total: data.total ?? 0 };
  },
  remove: (id: number) => http.deleteOk<null>(`/domains/renewable-domains/${id}`),
  toggle: (id: number, enabled: boolean) => http.patchOk<null>(`/domains/renewable-domains/${id}/toggle-enabled`, { enabled }),
  renew: (domainId: number) => http.postOk<unknown>(`/domains/${domainId}/renew`),
  providerDomains: async (accountId: number): Promise<ProviderDomainOption[]> => {
    const data = await unwrap(http.get<ProviderDomainOption[] | { list?: ProviderDomainOption[] }>(`/domains/provider-list/${accountId}`));
    return Array.isArray(data) ? data : (data?.list ?? []);
  },
  add: (payload: { account_id: number; provider_type?: string; domain_name: string; third_id: string; full_domain: string; expires_at?: string; remark?: string }) =>
    http.postOk<{ id: number }>('/domains/renewable-domains', payload),
};

export function isRenewableEnabled(row: RenewableDomainRow): boolean {
  return row.enabled === undefined || row.enabled === null ? true : Boolean(Number(row.enabled) || row.enabled === true);
}

export function daysLeft(iso?: string | null): number | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return null;
  return Math.ceil((time - Date.now()) / 86400000);
}
