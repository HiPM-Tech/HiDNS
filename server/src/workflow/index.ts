import { randomUUID } from 'node:crypto';
import { createLogger } from '../lib/logger';
import { isSystemInitialized } from '../service/systemState';
import { AuditOperations, UserOperations } from '../db/bal/business-adapter';
import { AVAILABLE_SERVICES, type AvailableService } from '../types/token';
import { WorkflowEngine, type WorkflowDefinition } from './engine';
import { createDispatcher } from './dispatch';
import { lookupActionMeta } from './actions/registry';
import { getStoredById, listEnabledDefinitions, recordRun, storedToDefinition } from './store';
import { getAccessibleDomains, getWritableDomainIds } from './access';
import { SettingsOperations } from '../db/bal/business-adapter';
import { setHttpFetchPolicy, getHttpFetchPolicy } from './actions/http/outbound';
import type { AuthorizeDeps, Principal } from './auth';
import { buildRecordEvent, type AnyDomainEvent, type DomainEvent as WorkflowEvent } from '../lib/domain-event-bus';

const log = createLogger('Workflow');

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;
const buckets = new Map<string, { count: number; resetAt: number }>();

/** 进程内令牌桶；单实例部署足够，多实例需换 Redis */
export function rateLimit(key: string): boolean {
  const now = Date.now();

  // 惰性清理：键是 principal × action，长期运行会无界增长
  if (buckets.size > 5000) {
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(bucketKey);
    }
  }

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_MAX) return false;
  bucket.count += 1;
  return true;
}

export const authorizeDeps: AuthorizeDeps = {
  lookupAction: lookupActionMeta,
  audit: async (record) => {
    const userId = Number(record.principalId);
    if (!Number.isFinite(userId)) return;
    await AuditOperations.log({
      user_id: userId,
      action: `workflow.${record.action}`,
      target_type: 'workflow',
      details: JSON.stringify({
        traceId: record.traceId,
        trigger: record.trigger,
        outcome: record.outcome,
        reason: record.reason,
        resource: record.resource,
      }),
    });
  },
  rateLimit,
  now: () => Date.now(),
  newTraceId: () => randomUUID(),
};

const READ_ONLY_SERVICES: AvailableService[] = [
  'records.read',
  'domains.read',
  'accounts.read',
  'tunnels.read',
  'system.read',
  'network.fetch',
  'notify.send',
];

function servicesForRole(roleLevel: number): AvailableService[] {
  // 管理员拥有全部服务权限；普通用户仅只读 + 出站/通知
  return roleLevel >= 2 ? [...AVAILABLE_SERVICES] : [...READ_ONLY_SERVICES];
}

export async function resolvePrincipal(workflow: WorkflowDefinition): Promise<Principal> {
  if (!workflow.ownerId) {
    throw new Error('工作流缺少创建者，无法确定执行身份');
  }
  const user = (await UserOperations.getById(workflow.ownerId)) as unknown as
    | { id: number; role_level?: number; status?: number }
    | undefined;
  if (!user) throw new Error('工作流创建者不存在');
  if (user.status !== undefined && user.status !== 1) throw new Error('工作流创建者已停用');
  const access = await getAccessibleDomains(user.id);
  const writable = await getWritableDomainIds(user.id);
  return {
    kind: 'user',
    id: String(user.id),
    role: (user.role_level ?? 1) >= 3 ? 'super_admin' : (user.role_level ?? 1) >= 2 ? 'admin' : 'user',
    services: servicesForRole(user.role_level ?? 1),
    // 域名级权限按 owner 真实可访问集合计算；**不得**再用 '*' 通配
    allowedDomainIds: access.ids,
    allowedWriteDomainIds: writable,
    // 名称名单同样必要：domainId=0（如 ns.changed）时只能按名称判定
    allowedDomains: access.names,
  };
}

/**
 * 租户边界：工作流 owner 是否有权访问事件所属域名。
 *
 * 主键优先、名称兜底，与 `workflow/auth.ts` 的 `assertDomainPermission` 保持同一口径：
 * - `domain.id > 0` 时它就是权威主键，未命中必须直接拒绝。此前 id 未命中会回落到
 *   名称比较，而同一个 zone 挂到两个账号（同名域名）时会因此放行到他人域名；
 * - 只有 `domain.id = 0` 才表示主键缺失（ns.changed 的 ns_monitor_domains 表无
 *   domain_id 列），此时只能按名称判定。
 *
 * 已知口径差异（本次不扩大）：这里用 `getAccessibleDomains`，即「账号 created_by +
 * domain_permissions 直接授权」，不含团队授权与超管旁路，因此比 HTTP 层
 * （routes/domains.ts 的 resolveDomainAccess）更窄。方向是 fail-closed：表现为工作流
 * 在该域名上不触发，引擎会记 warn 并落 skipped/no-domain-access。扩大口径会同步扩大
 * 工作流的可写域名范围，属独立的产品/安全决策，需另行评审。
 */
export async function canAccessEventDomain(
  workflow: { ownerId?: number },
  domain: { id: number; name: string },
): Promise<boolean> {
  if (!workflow.ownerId) return false;
  const access = await getAccessibleDomains(workflow.ownerId);
  if (domain.id > 0) return access.ids.includes(domain.id);
  return Boolean(domain.name) && access.names.includes(domain.name);
}

/**
 * 运行记录里的触发事件快照。
 *
 * `no-domain-access` 的跳过记录对应的是**他人域名**的事件：原样落库会让工作流 owner
 * 通过 `GET /api/workflows/:id/runs` 读到无权访问的域名名与解析值（`listRuns` 是
 * `SELECT *`，trigger_event 会原样返回）。因此这类记录只保留定位问题所需的骨架。
 */
export function toStoredTriggerEvent(run: {
  status: string;
  error?: string;
  traceId: string;
  event?: AnyDomainEvent;
}): unknown {
  if (!run.event) return undefined;
  if (run.status === 'skipped' && run.error === 'no-domain-access') {
    return {
      type: run.event.type,
      traceId: run.traceId,
      at: run.event.at,
      redacted: 'no-domain-access',
    };
  }
  return run.event;
}

let engine: WorkflowEngine | null = null;

/**
 * 装载出站白名单。
 * 此前 `setHttpFetchPolicy` 只在测试里调用，生产 allowlist 恒为空，
 * 导致 `http.outbound.fetch` **永远** NOT_ALLOWLISTED（fail-closed 退化成 fail-always）。
 */
/** 供路由/前端展示当前出站白名单（设计 §5.5.1），避免路由直连 actions 实现 */
export function getOutboundAllowlist(): string[] {
  return [...getHttpFetchPolicy().allowlist];
}

export async function reloadOutboundPolicy(): Promise<void> {
  try {
    const raw = (await SettingsOperations.get('workflow_http_allowlist')) as unknown as
      | string
      | { value?: string }
      | null
      | undefined;
    const value = typeof raw === 'string' ? raw : raw?.value;
    // 规范（§5.5.1）约定存 JSON 数组；同时兼容历史/手写的逗号分隔
    const rawValue = String(value ?? '').trim();
    let allowlist: string[] = [];
    let parsedJson = false;
    if (rawValue.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(rawValue);
        if (Array.isArray(parsed)) {
          // JSON 解析成功即短路：空数组是**合法配置**，不能当成解析失败回退成 CSV
          allowlist = parsed.map((item) => String(item).trim()).filter(Boolean);
          parsedJson = true;
        }
      } catch {
        log.warn('workflow http allowlist is not valid JSON, falling back to CSV');
      }
    }
    if (!parsedJson) {
      allowlist = rawValue.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
    }
    setHttpFetchPolicy({ allowlist });
    if (allowlist.length === 0) {
      log.warn('workflow http allowlist is empty; http.outbound.fetch will reject everything');
    }
  } catch (error) {
    log.warn('load workflow http allowlist failed', { error: (error as Error).message });
  }
}

export function startWorkflowModule(): void {
  if (engine) return;
  if (!isSystemInitialized()) {
    log.info('workflow module not started: system not initialized');
    return;
  }

  void reloadOutboundPolicy();

  const dispatcher = createDispatcher({ authorizeDeps });

  engine = new WorkflowEngine({
    listWorkflows: listEnabledDefinitions,
    getWorkflowById: async (id) => {
      const stored = await getStoredById(Number(id));
      return stored ? storedToDefinition(stored) : null;
    },
    canAccessDomain: canAccessEventDomain,
    resolvePrincipal: (workflow) => resolvePrincipal(workflow),
    dispatch: dispatcher,
    onRun: async (run) => {
      const workflowId = Number(run.workflowId);
      if (!Number.isFinite(workflowId)) return;
      await recordRun({
        workflowId,
        traceId: run.traceId,
        status: run.status,
        error: run.error,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        triggerEvent: toStoredTriggerEvent(run),
        depth: run.depth,
      });
    },
  });

  engine.start();
  log.info('workflow module started');
}

export function stopWorkflowModule(): void {
  engine?.stop();
  engine = null;
}

export function isWorkflowModuleRunning(): boolean {
  return engine !== null;
}

export class WorkflowNotRunningError extends Error {
  constructor() {
    super('工作流模块未启动（系统未初始化或仍在降级模式）');
    this.name = 'WorkflowNotRunningError';
  }
}

export class InvalidSyntheticEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSyntheticEventError';
  }
}

/**
 * 手动运行：用调用方提供的合成事件执行一次。
 * 合成事件只允许 A / AAAA —— 与事件主线同一套过滤（§4.0.5），
 * 否则手动运行会成为绕过类型约束的后门。
 */
export async function runWorkflowManually(
  workflowId: number,
  input: {
    domain: { id: number; name: string };
    record: { id?: string; name: string; type: string; value?: string; oldValue?: string };
  },
): Promise<{ status: string; traceId: string; error?: string } | null> {
  if (!engine) throw new WorkflowNotRunningError();

  const event = buildRecordEvent({
    action: 'updated',
    domain: input.domain,
    record: {
      id: input.record.id ?? 'manual',
      name: input.record.name,
      type: input.record.type,
      value: input.record.value,
      oldValue: input.record.oldValue,
    },
    actor: { source: 'api' },
  });

  if (!event) {
    throw new InvalidSyntheticEventError(`合成事件仅支持 A / AAAA，收到 ${input.record.type}`);
  }

  const record = await engine.runSingle(String(workflowId), event);
  return record ? { status: record.status, traceId: record.traceId, error: record.error } : null;
}

export type { WorkflowEvent };