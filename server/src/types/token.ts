// User Token Types

export interface UserToken {
  id: number;
  user_id: number;
  name: string;
  token_hash: string;
  allowed_domains: string; // JSON array of domain IDs
  allowed_services: string; // JSON array of service names
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
  allowed_services: string[];
  start_time?: string;
  end_time?: string;
  max_role: number;
}

export interface UserTokenResponse {
  id: number;
  name: string;
  allowed_domains: number[];
  allowed_services: string[];
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
  allowedServices: string[];
}

// Available services for token permissions
export const AVAILABLE_SERVICES = [
  'domains.read',
  'domains.write',
  'records.read',
  'records.write',
  'accounts.read',
  'accounts.write',
  'tunnels.read',
  'tunnels.write',
  'system.read',
  'network.fetch',
  'notify.send',
  'workflow.read',
  'workflow.write',
  'workflow.run',
] as const;

export type AvailableService = typeof AVAILABLE_SERVICES[number];
