import { http } from '../../lib/http';

export interface AccountRow {
  id: number;
  name: string;
  type: string;
  config?: Record<string, string>;
  remark?: string | null;
  enabled?: boolean | number;
  created_by?: number | null;
  team_id?: number | null;
}

export interface ProviderConfigField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'select';
  required: boolean;
  group?: string;
  options?: Array<{ label: string; value: string }>;
}

export interface ProviderInfo {
  type: string;
  name: string;
  capabilities: {
    dns: { export?: string; recordTypes?: string[]; proxiable?: boolean } | null;
    log?: boolean;
    renewal?: boolean;
  };
  configFields: ProviderConfigField[];
  isStub?: boolean;
}

export interface AccountQuery {
  keyword?: string;
  type?: string;
  purpose?: 'dns' | 'renewal';
}

export interface AccountPayload {
  type?: string;
  name?: string;
  config?: Record<string, string>;
  remark?: string;
  team_id?: number | null;
}

export async function listAccounts(query: AccountQuery = {}): Promise<AccountRow[]> {
  const envelope = await http.get<AccountRow[] | { list?: AccountRow[] }>('/accounts', {
    query: { keyword: query.keyword || undefined, type: query.type || undefined, purpose: query.purpose },
  });
  const data = envelope.data;
  return Array.isArray(data) ? data : (data?.list ?? []);
}

export async function listProviders(): Promise<ProviderInfo[]> {
  const envelope = await http.get<ProviderInfo[]>('/accounts/providers');
  return Array.isArray(envelope.data) ? envelope.data : [];
}

export function createAccount(payload: AccountPayload) {
  return http.postOk<{ id: number }>('/accounts', payload);
}

export function updateAccount(id: number, payload: AccountPayload) {
  return http.putOk<null>(`/accounts/${id}`, payload);
}

export function deleteAccount(id: number) {
  return http.deleteOk<null>(`/accounts/${id}`);
}

export function isAccountEnabled(account: AccountRow): boolean {
  return account.enabled === undefined || account.enabled === null ? true : Boolean(Number(account.enabled) || account.enabled === true);
}
