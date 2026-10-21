/**
 * 解析后的目标位置（设计 §904 §4：审计要能回答「这次打的是哪个站点」）。
 *
 * 为什么不从步骤记录的 `input` 反推：`input` 只存实参，而 `domainId: 7` 事后无法还原成当时的站点
 * （`third_id` 可能已被重新同步、域名可能已被删）。`plan` 与 `replace` 又是两次独立解析，
 * 只要两步的 `resolvedTarget` 都落库，目标不一致在审计上一眼可见。
 *
 * 放在 `lib/` 而不是 `workflow/`：提供商层要能往上旁挂，但**不得反向依赖 workflow**。
 */
export interface ResolvedTarget {
  /** 用的是哪套契约：新契约（账号 + 作用域）还是旧形态（域名） */
  contract: 'v2' | 'v1-legacy';
  accountId?: number;
  scopeId?: string;
  siteType?: string;
  groupId?: string;
}

const RESOLVED_TARGET = Symbol('hins.resolvedTarget');

/**
 * 把解析结果旁挂到 handler 返回值上。
 *
 * 用**不可枚举的 symbol**：返回值是 DSL 可见的对外契约（可被 ``var.*`` 引用），
 * 不能因为内部审计需要就往里塞字段。引擎取走后一并删除。
 */
export function attachResolvedTarget<T>(value: T, target: ResolvedTarget): T {
  if (value && typeof value === 'object') {
    Object.defineProperty(value as object, RESOLVED_TARGET, {
      value: target,
      enumerable: false,
      configurable: true,
    });
  }
  return value;
}

/** 取出并移除旁挂的解析结果；没有则返回 undefined */
export function takeResolvedTarget(value: unknown): ResolvedTarget | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const holder = value as Record<symbol, ResolvedTarget | undefined>;
  const target = holder[RESOLVED_TARGET];
  if (target) delete holder[RESOLVED_TARGET];
  return target;
}
