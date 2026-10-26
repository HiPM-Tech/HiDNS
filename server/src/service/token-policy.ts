import type { AllowedServices } from '../types/token';
import { allTokenServices, parseAllowedServices } from './token-permissions';

/** API token creation policy. Omission keeps historical defaults; explicit empty objects deny all services. */

export interface TokenPolicyInput {
  allowedServices?: unknown;
  maxRole?: unknown;
  userRole: number;
}

export type TokenPolicyResult =
  | { ok: true; services: AllowedServices; maxRole: number }
  | { ok: false; status: number; message: string };

export function resolveTokenPolicy(input: TokenPolicyInput): TokenPolicyResult {
  const { allowedServices, maxRole, userRole } = input;

  const requestedRole = maxRole === undefined ? userRole : Number(maxRole);
  if (!Number.isInteger(requestedRole) || requestedRole < 0) {
    return { ok: false, status: 400, message: 'max_role must be a non-negative integer' };
  }
  if (requestedRole > userRole) {
    return { ok: false, status: 403, message: 'max_role cannot exceed your own role' };
  }

  try {
    const services = allowedServices === undefined ? allTokenServices() : parseAllowedServices(allowedServices);
    return { ok: true, services, maxRole: requestedRole };
  } catch (error) {
    return { ok: false, status: 400, message: (error as Error).message };
  }
}

/** 域名白名单归一化：仅保留正整数 id */
export function normalizeTokenDomains(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  return input.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0);
}
