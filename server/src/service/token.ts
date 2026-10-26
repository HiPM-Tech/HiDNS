import crypto from 'crypto';
import { TokenOperations, DomainOperations } from '../db/bal/business-adapter';
import { UserToken, UserTokenCreate, UserTokenResponse, TokenPayload, AllowedServices, DnsTokenPermission } from '../types/token';
import { parseAllowedServices, readAllowedServices } from './token-permissions';
import { isAdmin } from '../utils/roles';

const TOKEN_PREFIX = 'hidns_';
const LEGACY_TOKEN_PREFIX = 'dnsmgr_'; // 旧格式前缀，用于兼容

// Generate a new token
export function generateToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
}

// Check if token has valid prefix (supports both new and legacy formats)
function hasValidTokenPrefix(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX) || token.startsWith(LEGACY_TOKEN_PREFIX);
}

// Hash token for storage
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Create a new user token
export async function createUserToken(
  userId: number,
  data: UserTokenCreate
): Promise<{ token: string; tokenData: UserTokenResponse }> {
  // Generate token
  const plainToken = generateToken();
  const tokenHash = hashToken(plainToken);

  // Insert into database using business adapter
  const id = await TokenOperations.create({
    user_id: userId,
    name: data.name,
    token_hash: tokenHash,
    allowed_domains: JSON.stringify(data.allowed_domains),
    allowed_services: JSON.stringify(parseAllowedServices(data.allowed_services)),
    start_time: data.start_time || null,
    end_time: data.end_time || null,
    max_role: data.max_role,
  });

  const tokenData: UserTokenResponse = {
    id,
    name: data.name,
    allowed_domains: data.allowed_domains,
    allowed_services: data.allowed_services,
    start_time: data.start_time || null,
    end_time: data.end_time || null,
    max_role: data.max_role,
    is_active: true,
    created_at: new Date().toISOString(),
    last_used_at: null,
  };

  return { token: plainToken, tokenData };
}

// Verify a token and return payload
export async function verifyToken(plainToken: string): Promise<TokenPayload | null> {
  if (!hasValidTokenPrefix(plainToken)) return null;

  const tokenHash = hashToken(plainToken);

  // Use business adapter to get token
  const result = await TokenOperations.getByTokenHash(tokenHash) as UserToken | undefined;

  if (!result || !result.is_active) return null;

  // Check time restrictions
  const nowTime = new Date();
  if (result.start_time && new Date(result.start_time) > nowTime) return null;
  if (result.end_time && new Date(result.end_time) < nowTime) return null;

  // Update last used time using business adapter
  await TokenOperations.updateLastUsed(result.id);

  // 安全解析 JSON 字段
  const parseJson = (value: unknown): unknown => {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  };

  let allowedServices: AllowedServices;
  try {
    allowedServices = readAllowedServices(result.allowed_services);
  } catch {
    return null;
  }

  return {
    type: 'token',
    tokenId: result.id,
    userId: result.user_id,
    maxRole: result.max_role,
    allowedDomains: parseJson(result.allowed_domains) as number[],
    allowedServices,
  };
}

// Get all tokens for a user
export async function getUserTokens(userId: number): Promise<UserTokenResponse[]> {
  // Use business adapter to get tokens
  const results = await TokenOperations.getByUserId(userId) as unknown as UserToken[];

  return results.map((t) => {
    // 安全解析 JSON 字段，处理已经是对象的情况
    const parseJson = (value: unknown): unknown => {
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      return value;
    };

    return {
      id: t.id,
      name: t.name,
      allowed_domains: parseJson(t.allowed_domains) as number[],
      allowed_services: readAllowedServices(t.allowed_services),
      start_time: t.start_time,
      end_time: t.end_time,
      max_role: t.max_role,
      is_active: !!t.is_active,
      created_at: t.created_at,
      last_used_at: t.last_used_at,
    };
  });
}

// Delete a token
export async function deleteUserToken(tokenId: number, userId: number): Promise<void> {
  // Use business adapter to delete token
  await TokenOperations.deleteByUser(tokenId, userId);
}

// Toggle token active status
export async function toggleTokenStatus(tokenId: number, userId: number, isActive: boolean): Promise<void> {
  // Use business adapter to toggle status
  await TokenOperations.toggleStatusByUser(tokenId, userId, isActive);
}

// Update token permissions
export async function updateTokenPermissions(
  tokenId: number,
  userId: number,
  data: {
    name?: string;
    allowed_domains?: number[];
    allowed_services?: AllowedServices;
    start_time?: string | null;
    end_time?: string | null;
  }
): Promise<void> {
  // Permission-only edits must not silently remove the token's validity window.
  const startTime = data.start_time === undefined ? undefined : data.start_time || null;
  const endTime = data.end_time === undefined ? undefined : data.end_time || null;

  // Use business adapter to update token
  await TokenOperations.updateByUser(tokenId, userId, {
    name: data.name,
    allowed_domains: data.allowed_domains !== undefined ? JSON.stringify(data.allowed_domains) : undefined,
    allowed_services: data.allowed_services !== undefined ? JSON.stringify(parseAllowedServices(data.allowed_services)) : undefined,
    start_time: startTime,
    end_time: endTime,
  });
}

// Check if token has permission for a service
export function hasServicePermission(tokenPayload: TokenPayload, service: string): boolean {
  if (service !== 'dns' && service !== 'mcp') return false;
  return (tokenPayload.allowedServices[service]?.length ?? 0) > 0;
}

export function hasDnsPermission(tokenPayload: TokenPayload, permission: DnsTokenPermission): boolean {
  const permissions = tokenPayload.allowedServices.dns;
  return !!permissions && (permissions.includes('*') || permissions.includes(permission));
}

// Check if token has permission for a domain
// Also verifies that the token's creator (user) has access to the domain
export async function hasDomainPermission(tokenPayload: TokenPayload, domainId: number): Promise<boolean> {
  // First check if token explicitly allows this domain
  // 空数组 = 不限制（向后兼容 ddns-go 这类只配令牌的外部工具）；
  // 需要收敛权限时必须显式列域名。口径同 middleware/auth.ts 的 requireTokenDomainPermission。
  const tokenAllowsDomain = tokenPayload.allowedDomains.includes(domainId) ||
         tokenPayload.allowedDomains.length === 0;
  
  if (!tokenAllowsDomain) return false;
  
  // Admin users have access to all domains
  if (isAdmin(tokenPayload.maxRole)) {
    return true;
  }
  
  // Use business adapter to check domain access
  return await DomainOperations.checkUserDomainAccess(domainId, tokenPayload.userId);
}
