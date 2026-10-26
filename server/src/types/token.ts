// User Token Types

export interface UserToken {
  id: number;
  user_id: number;
  name: string;
  token_hash: string;
  allowed_domains: string; // JSON array of domain IDs
  allowed_services: string; // JSON object: service -> operation permissions
  start_time: string | null;
  end_time: string | null;
  max_role: number;
  is_active: number;
  created_at: string;
  last_used_at: string | null;
}

export interface UserTokenCreate {
  name: string;
  allowed_domains: number[];
  allowed_services: AllowedServices;
  start_time?: string;
  end_time?: string;
  max_role: number;
}

export interface UserTokenResponse {
  id: number;
  name: string;
  allowed_domains: number[];
  allowed_services: AllowedServices;
  start_time: string | null;
  end_time: string | null;
  max_role: number;
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
}

export interface TokenPayload {
  type: 'token';
  tokenId: number;
  userId: number;
  maxRole: number;
  allowedDomains: number[];
  allowedServices: AllowedServices;
}

export const DNS_TOKEN_PERMISSIONS = [
  'accounts.read', 'accounts.write',
  'domains.read', 'domains.write',
  'records.read', 'records.write',
  'providers.read', 'email-templates.read',
  'ns-monitor.read', 'ns-monitor.write',
  'servicemonitor.read', 'servicemonitor.write',
  'workflow.read', 'workflow.write', 'workflow.run',
] as const;

export type DnsTokenPermission = typeof DNS_TOKEN_PERMISSIONS[number];
export type TokenService = 'dns' | 'mcp';
export interface AllowedServices {
  dns?: Array<DnsTokenPermission | '*'>;
  mcp?: Array<'*'>;
}

// Workflow action permissions (separate from UserToken service groups).
export const AVAILABLE_SERVICES = [
  'domains.read',
  'domains.write',
  'records.read',
  'records.write',
  'accounts.read',
  'accounts.write',
  'system.read',
  'network.fetch',
  'notify.send',
  'workflow.read',
  'workflow.write',
  'workflow.run',
] as const;

export type AvailableService = typeof AVAILABLE_SERVICES[number];
