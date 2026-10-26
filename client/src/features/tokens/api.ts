import { http } from '../../lib/http';
import type { AllowedServices } from './permissions';

export interface TokenRow {
  id: number;
  name: string;
  allowed_domains: number[];
  allowed_services: AllowedServices;
  max_role?: number;
  start_time?: string | null;
  end_time?: string | null;
  is_active?: boolean | number;
  created_at?: string;
  last_used_at?: string | null;
}

export interface TokenDomainOption {
  id: number;
  name: string;
  account_name?: string;
}

export interface TokenPayload {
  name: string;
  allowed_domains: number[];
  allowed_services: AllowedServices;
  max_role?: number;
  start_time?: string | null;
  end_time?: string | null;
}

export interface CreatedToken {
  token: string;
  tokenData: TokenRow;
}

export async function listTokens(): Promise<TokenRow[]> {
  const envelope = await http.get<TokenRow[] | { list?: TokenRow[] }>('/tokens');
  const data = envelope.data;
  return Array.isArray(data) ? data : (data?.list ?? []);
}

export async function listTokenDomains(): Promise<TokenDomainOption[]> {
  const envelope = await http.get<TokenDomainOption[]>('/tokens/domains');
  return Array.isArray(envelope.data) ? envelope.data : [];
}

export function createToken(payload: TokenPayload) {
  return http.postOk<CreatedToken>('/tokens', payload);
}

export function updateToken(id: number, payload: Partial<TokenPayload>) {
  return http.putOk<null>(`/tokens/${id}`, payload);
}

export function deleteToken(id: number) {
  return http.deleteOk<null>(`/tokens/${id}`);
}

export function toggleTokenStatus(id: number, isActive: boolean) {
  return http.patchOk<null>(`/tokens/${id}/status`, { is_active: isActive });
}

export function isTokenActive(token: TokenRow): boolean {
  return token.is_active === undefined || token.is_active === null ? true : Boolean(Number(token.is_active));
}
