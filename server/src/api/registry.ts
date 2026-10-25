import { createLogger } from '../lib/logger';
import type { ApiManifestEntry, ApiModule } from './types';

const log = createLogger('HTTP').sub('ApiRegistry');

/** 前缀格式：/api 起头，至少两级，不含结尾斜杠与查询串 */
const PREFIX_PATTERN = /^\/api(\/[A-Za-z0-9_:.-]+)+$/;

/**
 * 注册并校验模块清单。
 *
 * 校验项（违反即抛错，启动期 fail-fast）：
 * - id 唯一；
 * - prefix 唯一（同一前缀挂两个 router 会让后者被永久遮蔽，见历史 securityPolicy 事故）；
 * - prefix 合法；
 * - description 必填。
 *
 * 顺序风险只告警不抛错：静态子路径若注册在父前缀之后，会被父路由先吃到。
 */
export function defineApiModules(modules: readonly ApiModule[]): readonly ApiModule[] {
  const seenIds = new Set<string>();
  const seenPrefixes = new Map<string, string>();

  for (const module of modules) {
    if (!module.id || !module.id.trim()) {
      throw new Error('API module requires a non-empty id');
    }
    if (seenIds.has(module.id)) {
      throw new Error(`Duplicate API module id: ${module.id}`);
    }
    if (!PREFIX_PATTERN.test(module.prefix)) {
      throw new Error(`Invalid API prefix for module ${module.id}: ${module.prefix}`);
    }
    // Express 路由大小写不敏感、/:a 与 /:b 等价，唯一性必须按归一化后的键比较
    const normalizedPrefix = normalizePrefixKey(module.prefix);
    const owner = seenPrefixes.get(normalizedPrefix);
    if (owner) {
      throw new Error(`Duplicate API prefix ${module.prefix} (modules: ${owner}, ${module.id}). ` +
        'Merge the routers instead of mounting twice — the later one is shadowed.');
    }
    if (!module.description || !module.description.trim()) {
      throw new Error(`API module ${module.id} requires a description`);
    }
    for (const probe of module.closedStateProbes ?? []) {
      if (!probe.startsWith(module.prefix)) {
        throw new Error(`closedStateProbes of ${module.id} must live under ${module.prefix}: ${probe}`);
      }
    }
    seenIds.add(module.id);
    seenPrefixes.set(normalizedPrefix, module.id);
  }

  warnShadowedNesting(modules);
  return [...modules];
}

/** 归一化前缀键：小写 + 参数名折叠（/:domainId ≡ /:id） */
function normalizePrefixKey(prefix: string): string {
  return prefix
    .toLowerCase()
    .split('/')
    .map((segment) => (segment.startsWith(':') ? ':' : segment))
    .join('/');
}

/** 静态子路径注册在父前缀之后 → 可能被父路由抢先匹配（历史 email-templates 事故；仅供参考，用 debug 输出） */
function warnShadowedNesting(modules: readonly ApiModule[]): void {
  for (let i = 0; i < modules.length; i += 1) {
    for (let j = i + 1; j < modules.length; j += 1) {
      const parent = modules[i];
      const child = modules[j];
      if (!child.prefix.startsWith(`${parent.prefix}/`)) continue;
      const nextSegment = child.prefix.slice(parent.prefix.length + 1).split('/')[0];
      if (nextSegment.includes(':')) continue; // 参数段由路由自身决定，不构成遮蔽
      // 注意：嵌套挂载（如 /api/auth 与 /api/auth/webauthn）本身是合法的，这里只作提示
      log.debug('Static child API prefix is registered after its parent; verify parent does not catch-all', {
        parent: parent.prefix,
        child: child.prefix,
      });
    }
  }
}

export function toManifest(modules: readonly ApiModule[]): ApiManifestEntry[] {
  return modules.map((module) => ({
    id: module.id,
    prefix: module.prefix,
    exemptFromInitGate: module.exemptFromInitGate === true,
    closedStateProbes: [...(module.closedStateProbes ?? [])],
    middlewareCount: module.middlewares?.length ?? 0,
    service: module.service ?? null,
    description: module.description,
  }));
}

export function getExemptPrefixes(modules: readonly ApiModule[]): string[] {
  return modules.filter((module) => module.exemptFromInitGate === true).map((module) => module.prefix);
}
