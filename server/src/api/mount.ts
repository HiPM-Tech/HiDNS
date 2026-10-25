import type { Application } from 'express';
import { createLogger } from '../lib/logger';
import type { ApiModule } from './types';

const log = createLogger('HTTP').sub('ApiMount');

/**
 * 按清单顺序挂载模块。挂载是本层唯一的写操作，业务模块不得自行 app.use。
 */
export function mountApiModules(app: Application, modules: readonly ApiModule[]): void {
  for (const module of modules) {
    app.use(module.prefix, ...(module.middlewares ?? []), module.router);
  }
  log.info('API modules mounted', {
    count: modules.length,
    prefixes: modules.map((module) => module.prefix),
  });
}
