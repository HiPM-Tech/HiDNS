import type { Application } from 'express';
import { createLogger } from '../lib/logger';
import type { ApiModule } from './types';
import { sendError } from '../utils/http';
import { hasServicePermission, verifyToken } from '../service/token';
import type { Request, Response, NextFunction } from 'express';

const log = createLogger('HTTP').sub('ApiMount');

/**
 * 服务级门禁：在路由自身 authMiddleware 之前校验 API 令牌的 allowed_services。
 * 只有携带 Bearer 令牌时才校验；会话 JWT / 无凭据请求交给路由内的 authMiddleware。
 */
function buildServiceGate(service: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      next();
      return;
    }
    const payload = await verifyToken(header.slice(7).trim());
    if (!payload) {
      // 无效令牌交给 authMiddleware 统一返回 401
      next();
      return;
    }
    (req as unknown as { tokenPayload?: unknown }).tokenPayload = payload;
    if (!hasServicePermission(payload, service)) {
      sendError(res, 'Token does not have permission for ' + service, 403);
      return;
    }
    next();
  };
}

/**
 * 按清单顺序挂载模块。挂载是本层唯一的写操作，业务模块不得自行 app.use。
 */
export function mountApiModules(app: Application, modules: readonly ApiModule[]): void {
  for (const module of modules) {
    // 服务级门禁：仅在模块声明 service 时生效；会话 JWT（无 tokenPayload）直接放行
    const gate = module.service ? [buildServiceGate(module.service)] : [];
    app.use(module.prefix, ...gate, ...(module.middlewares ?? []), module.router);
  }
  log.info('API modules mounted', {
    count: modules.length,
    prefixes: modules.map((module) => module.prefix),
  });
}
