import type { AvailableService } from '../types/token';
import type { ActionClass } from '../types/namespace';
import { DOMAIN_TRIGGERS } from './triggers';

/**
 * 统一鉴权闸门。
 * 设计依据：docs/WORKFLOW_ENGINE_DESIGN.md §5.0 / D22
 *
 * 关键约束：ActionContext 带私有 brand，**只能由 authorize() 签发**。
 * 因此任何 handler 都无法在未授权状态下被调用 —— 内部调用同样如此。
 */

declare const AUTHORIZED: unique symbol;

export type TriggerKind = 'event' | 'manual' | 'api' | 'internal';

export type Role = 'user' | 'admin' | 'super_admin';

export interface Principal {
  readonly kind: 'user' | 'token' | 'system';
  readonly id: string;
  readonly role: Role;
  readonly services: readonly AvailableService[];
  /** 允许的域名 ID 集合（首选判定依据） */
  readonly allowedDomainIds?: readonly number[];
  /** 允许的域名名称集合；'*' 仅用于显式构造的测试/系统身份，生产执行身份一律给具体集合 */
  readonly allowedDomains: readonly string[] | '*';
  /** 毫秒时间戳；缺省表示不限期 */
  readonly expiresAt?: number;
}

export interface ResourceRef {
  readonly domainId?: number;
  readonly accountId?: number;
  readonly scopeId?: string;
  /** 目标域名（用于域名级权限判定） */
  readonly domainName?: string;
}

export interface ActionContext {
  readonly [AUTHORIZED]: true;
  readonly principal: Principal;
  readonly action: string;
  readonly actionClass: ActionClass;
  readonly resource?: ResourceRef;
  readonly traceId: string;
  /** 事件传播深度：动作产生的写入事件应取 depth + 1（§7.2 防循环第二层） */
  readonly depth: number;
  readonly trigger: TriggerKind;
  readonly signal: AbortSignal;
  /** 工作流运行期局部变量（只读快照），由引擎注入 */
  readonly vars?: Readonly<Record<string, unknown>>;
}

export interface AuditRecord {
  readonly action: string;
  readonly principalId: string;
  readonly principalKind: Principal['kind'];
  readonly resource?: ResourceRef;
  readonly traceId: string;
  readonly trigger: TriggerKind;
  readonly outcome: 'allowed' | 'denied';
  readonly reason?: string;
  readonly at: string;
}

/** 动作的鉴权元数据（由注册表提供，避免 auth 反向依赖 registry） */
export interface ActionMeta {
  readonly name: string;
  readonly actionClass: ActionClass;
  readonly service: AvailableService;
  readonly dslVisible: boolean;
}

export interface AuthorizeDeps {
  /** 精确查找动作；未命中返回 null（禁止前缀/通配匹配） */
  lookupAction(name: string): ActionMeta | null;
  /** write-ahead 审计：resolve 即视为已落库 */
  audit(record: AuditRecord): Promise<void>;
  /** 返回 true 表示放行 */
  rateLimit(key: string): boolean;
  now(): number;
  newTraceId(): string;
}

export interface AuthorizeOptions {
  readonly trigger?: TriggerKind;
  /** 触发器类型（如 'record.changed' / 'domain.changed'），用于组合裁决 */
  readonly triggerType?: string;
  readonly signal?: AbortSignal;
  readonly vars?: Readonly<Record<string, unknown>>;
  /** 复用调用方 traceId（事件链路可追溯）；缺省自动生成 */
  readonly traceId?: string;
  /** 当前事件深度；动作写入事件应取 depth + 1 */
  readonly depth?: number;
}

/** 组合裁决：域名变动类触发器不得触发写动作（§4.0）；集合来自共享常量，避免两处漂移 */
const WRITE_CLASSES = new Set<ActionClass>(['dns.record.write', 'ext.write']);

export function isCombinationAllowed(triggerType: string, actionClass: ActionClass): boolean {
  if (!DOMAIN_TRIGGERS.has(triggerType)) return true;
  return !WRITE_CLASSES.has(actionClass);
}

export class AuthorizationError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

function assertDomainPermission(principal: Principal, resource?: ResourceRef): void {
  if (!resource) return;
  if (principal.allowedDomains === '*' && !principal.allowedDomainIds) return;

  // 优先按 ID 判定：事件里的 domain.id 是权威主键，名称可能大小写/IDN 不一致
  // domainId=0 表示「未知主键」（如 ns.changed 表无 domain_id），此时必须落到名称判定
  if (resource.domainId !== undefined && resource.domainId > 0 && principal.allowedDomainIds) {
    if (principal.allowedDomainIds.includes(resource.domainId)) return;
    throw new AuthorizationError(403, `域名权限不足: #${resource.domainId}`);
  }

  if (!resource.domainName) return;
  if (Array.isArray(principal.allowedDomains) && principal.allowedDomains.includes(resource.domainName)) return;
  throw new AuthorizationError(403, `域名权限不足: ${resource.domainName}`);
}

/**
 * 八步裁决。任一失败即拒绝，不降级为匿名执行。
 */
export async function authorize(
  action: string,
  principal: Principal,
  resource: ResourceRef | undefined,
  deps: AuthorizeDeps,
  options: AuthorizeOptions = {},
): Promise<ActionContext> {
  const trigger = options.trigger ?? 'internal';
  const triggerType = options.triggerType ?? trigger;
  const traceId = options.traceId ?? deps.newTraceId();
  const depth = options.depth ?? 0;

  const deny = async (status: number, reason: string): Promise<never> => {
    await deps.audit({
      action,
      principalId: principal?.id ?? '(none)',
      principalKind: principal?.kind ?? 'user',
      resource,
      traceId,
      trigger,
      outcome: 'denied',
      reason,
      at: new Date(deps.now()).toISOString(),
    });
    throw new AuthorizationError(status, reason);
  };

  // 1) 动作名精确命中
  const meta = deps.lookupAction(action);
  if (!meta) await deny(404, `未知动作: ${action}`);

  // 2) principal 有效性
  if (!principal || !principal.id) await deny(401, '缺少执行身份');
  if (principal.expiresAt !== undefined && principal.expiresAt <= deps.now()) {
    await deny(401, '执行身份已过期');
  }

  // 3) 服务权限
  if (!principal.services.includes(meta!.service)) {
    await deny(403, `缺少服务权限: ${meta!.service}`);
  }

  // 4) 资源权限
  try {
    assertDomainPermission(principal, resource);
  } catch (error) {
    await deny(403, (error as Error).message);
  }

  // 5) 组合裁决
  if (!isCombinationAllowed(triggerType, meta!.actionClass)) {
    await deny(422, `触发源 ${triggerType} 不得触发 ${meta!.actionClass} 动作`);
  }

  // 6) DSL 通道
  if (trigger === 'event' && !meta!.dslVisible) {
    await deny(403, `动作 ${action} 不对声明式 DSL 可见`);
  }

  // 7) 速率与配额
  if (!deps.rateLimit(`${principal.id}:${action}`)) {
    await deny(429, '调用频率超限');
  }

  // 8) write-ahead 审计：落库成功才放行
  await deps.audit({
    action,
    principalId: principal.id,
    principalKind: principal.kind,
    resource,
    traceId,
    trigger,
    outcome: 'allowed',
    at: new Date(deps.now()).toISOString(),
  });

  const ctx: ActionContext = {
    principal,
    action: meta!.name,
    actionClass: meta!.actionClass,
    resource,
    traceId,
    trigger,
    depth,
    signal: options.signal ?? new AbortController().signal,
    vars: options.vars,
  } as ActionContext;

  return ctx;
}

/** 受限的系统身份：权限为枚举白名单，不等于管理员 */
export function createSystemPrincipal(services: readonly AvailableService[]): Principal {
  return {
    kind: 'system',
    id: 'system:workflow',
    role: 'user',
    services,
    allowedDomains: [],
  };
}
