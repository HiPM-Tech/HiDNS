import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JwtPayload } from '../types';
import { isAdmin, normalizeRole } from '../utils/roles';
import { verifyToken, hasServicePermission, hasDomainPermission, hasDnsPermission } from '../service/token';
import { dnsPermissionForRoute } from '../api/token-permissions';
import { TokenPayload } from '../types/token';
import { sendError } from '../utils/http';
import { getJwtSecret, signToken } from '../service/jwt';
import { createLogger } from '../lib/logger';

const log = createLogger('HTTP').sub('Middleware').sub('Auth');

export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Try to get token from httpOnly cookie first, then fallback to Authorization header
  let token = req.cookies?.token;

  if (!token) {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      token = header.slice(7);
    }
  }

  if (!token) {
    sendError(res, 'Unauthorized', 401);
    return;
  }

  // First try to verify as JWT
  try {
    const jwtSecret = await getJwtSecret();
    const payload = jwt.verify(token, jwtSecret) as JwtPayload;
    req.user = { ...payload, role: normalizeRole(payload.role) };
    next();
    return;
  } catch {
    // Not a valid JWT, try user token
  }

  // Try to verify as user token
  const tokenPayload = await verifyToken(token);
  if (tokenPayload) {
    const permission = dnsPermissionForRoute(req.baseUrl, req.method, req.route?.path ?? '');
    if (permission && !hasDnsPermission(tokenPayload, permission)) {
      sendError(res, 'Token does not have permission for dns:' + permission, 403);
      return;
    }
    // Convert token payload to user payload
    req.user = {
      userId: tokenPayload.userId,
      username: `token:${tokenPayload.tokenId}`,
      role: tokenPayload.maxRole as 1 | 2 | 3,
    };
    // Store token payload for permission checks
    (req as any).tokenPayload = tokenPayload;
    next();
    return;
  }

  sendError(res, 'Invalid or expired token', 401);
}

// Middleware to check token service permission
export function requireServicePermission(service: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const tokenPayload = (req as any).tokenPayload as TokenPayload | undefined;

    // If not using token auth, allow (JWT auth has its own checks)
    if (!tokenPayload) {
      next();
      return;
    }

    if (!hasServicePermission(tokenPayload, service)) {
      sendError(res, 'Token does not have permission for ' + service, 403);
      return;
    }

    next();
  };
}

// Middleware to check token domain permission
export function requireDomainPermission(getDomainId: (req: Request) => number | null) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const tokenPayload = (req as any).tokenPayload as TokenPayload | undefined;

    // If not using token auth, allow
    if (!tokenPayload) {
      next();
      return;
    }

    const domainId = getDomainId(req);
    if (domainId !== null && !(await hasDomainPermission(tokenPayload, domainId))) {
      sendError(res, 'Token does not have permission for this domain', 403);
      return;
    }

    next();
  };
}

export function adminOnly(req: Request, res: Response, next: NextFunction): void {
  if (!isAdmin(req.user?.role)) {
    sendError(res, 'Admin access required', 403);
    return;
  }
  next();
}

/**
 * 检查是否使用令牌授权（而非 JWT/Session）
 * 用于限制令牌不能访问某些敏感路由
 */
function isTokenAuth(req: Request): boolean {
  return !!(req as any).tokenPayload;
}

/**
 * 禁止令牌授权访问的中间件
 * 用于保护敏感路由，如令牌管理、系统设置等
 * @param routeName 路由名称（用于错误提示）
 */
export function noTokenAuth(routeName: string = 'this resource') {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isTokenAuth(req)) {
      sendError(res, 'API token is not allowed to access ' + routeName + '. Please use JWT authentication.', 403);
      return;
    }
    next();
  };
}

/**
 * 要求 JWT 认证（禁止使用令牌）的中间件
 * 组合了 authMiddleware 和 noTokenAuth 的功能
 * 用于超管权限路由
 */
export function requireJwtAuth(routeName: string = 'this resource') {
  return [
    authMiddleware,
    noTokenAuth(routeName)
  ];
}

/**
 * 检查 API 令牌是否有权限操作指定域名
 * 用于保护域名操作路由，防止令牌越权
 * @param paramName 域名ID参数名，默认为'id'，记录路由使用'domainId'
 */
export function requireTokenDomainPermission(paramName: string = 'id') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const tokenPayload = (req as any).tokenPayload as TokenPayload | undefined;

    // 如果不是令牌认证，直接通过
    if (!tokenPayload) {
      next();
      return;
    }

    // allowedDomains 语义（唯一口径，与 service/token.ts 的 hasDomainPermission 一致）：
    //   null/undefined → 不限制（历史令牌）
    //   []            → **不限制**（向后兼容 ddns-go 等只填令牌、不填域名的外部工具）
    //   [1,2,3]       → 白名单，只能访问列出的域名
    // 曾经这里写着「[] 表示不允许任何域名（白名单机制）」，与实现相反，容易误判安全边界。
    if (tokenPayload.allowedDomains === null || tokenPayload.allowedDomains === undefined) {
      next();
      return;
    }

    // 空数组表示允许所有域名（向后兼容 ddns-go 等外部工具）
    // 如果需要限制权限，请显式配置 allowedDomains
    if (tokenPayload.allowedDomains.length === 0) {
      log.debug('Token has no domain restrictions, allowing all domains', {
        tokenId: tokenPayload.tokenId,
        userId: tokenPayload.userId
      });
      next();
      return;
    }

    // 获取请求中的域名 ID
    const domainId = req.params[paramName] ? parseInt(req.params[paramName], 10) : req.body.domain_id;

    if (!domainId || isNaN(domainId)) {
      sendError(res, 'Domain ID is required for API token access', 403);
      return;
    }

    // 检查域名是否在允许的列表中
    if (!tokenPayload.allowedDomains.includes(domainId)) {
      sendError(res, 'API token does not have permission to access this domain', 403);
      return;
    }

    next();
  };
}

