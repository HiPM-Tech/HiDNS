/**
 * API 令牌创建策略（纯函数，便于单测）。
 *
 * 语义：
 * - 服务权限：显式传入则按传入值持久化（去空白、丢弃空串）；未传则保持历史默认 `['*']`
 *   （等价于"与创建者同权限"，因为服务级门禁尚未全面接线，收紧默认值会直接改变现有令牌行为）；
 * - 角色上限：不得超过创建者自身角色，且必须是非负整数（历史实现固定取创建者角色，无法降级签发）。
 */

export interface TokenPolicyInput {
  allowedServices?: unknown;
  maxRole?: unknown;
  userRole: number;
}

export type TokenPolicyResult =
  | { ok: true; services: string[]; maxRole: number }
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

  let services: string[] = ['*'];
  if (Array.isArray(allowedServices) && allowedServices.length > 0) {
    services = allowedServices
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim());
    if (services.length === 0) {
      return { ok: false, status: 400, message: 'allowed_services must contain at least one service' };
    }
  }

  return { ok: true, services, maxRole: requestedRole };
}

/** 域名白名单归一化：仅保留正整数 id */
export function normalizeTokenDomains(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  return input.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0);
}
