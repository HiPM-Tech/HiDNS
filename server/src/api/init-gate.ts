import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createLogger } from '../lib/logger';
import { getExemptPrefixes } from './registry';
import type { ApiModule } from './types';

const log = createLogger('HTTP').sub('ApiGate');

export interface InitGateDeps {
  /** 系统是否已初始化（粘性标记） */
  isInitialized: () => boolean;
  /** 初始化面是否允许开放：仅「未初始化且数据库可达」为真 */
  isSurfaceOpen: () => boolean;
}

/**
 * 初始化门禁：默认拒绝 + 显式豁免。
 *
 * 三态语义（对应 root.ai.md §应用初始化与生命周期 2/4）：
 * - initialized   → 放行全部 /api；
 * - uninitialized → 只放行豁免模块（/api/init、/api/rdap），其余 503 needsInit；
 * - unreachable   → **初始化面一并关闭**，只放行各模块显式声明的只读探测路径，
 *                   否则「数据库故障 → 重配数据库 → 建管理员」的接管链成立。
 *
 * 路径比较统一转小写：Express 路由大小写不敏感，而历史实现用
 * `startsWith('/api/')` 做敏感比较，`GET /API/mcp/status` 可绕过门禁。
 */
export function createInitGate(modules: readonly ApiModule[], deps: InitGateDeps): RequestHandler {
  const exempt = getExemptPrefixes(modules).map((prefix) => prefix.toLowerCase());
  const probes = modules
    .flatMap((module) => module.closedStateProbes ?? [])
    .map((probe) => probe.toLowerCase());

  const matches = (pathname: string, prefixes: readonly string[]): boolean =>
    prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

  // 只读探测：仅放行读语义的方法，写操作即使在 probes 里也必须关闭
  const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

  return function initGate(req: Request, res: Response, next: NextFunction): void {
    const pathname = req.path.toLowerCase();

    // 静态资源与 SPA 不受门禁约束，否则初始化向导页面无法加载
    if (!pathname.startsWith('/api')) {
      next();
      return;
    }
    if (deps.isInitialized()) {
      next();
      return;
    }
    if (!deps.isSurfaceOpen()) {
      // 数据库不可达：除只读探测外一律关闭（方法维度同样受限）
      if (matches(pathname, probes) && READ_ONLY_METHODS.has(req.method.toUpperCase())) {
        next();
        return;
      }
      log.warn('Blocked API request while database is unreachable', { path: req.path, method: req.method });
      res.status(503).json({
        code: 503,
        msg: 'Database unreachable. The setup surface is closed until the database recovers.',
        data: { needsInit: false, dbReachable: false },
      });
      return;
    }
    if (matches(pathname, exempt)) {
      next();
      return;
    }
    res.status(503).json({
      code: 503,
      msg: 'System not initialized. Please complete setup first.',
      data: { needsInit: true, dbReachable: true },
    });
  };
}
