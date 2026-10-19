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
import { setHttpFetchPolicy } from './actions/http/outbound';
import type { AuthorizeDeps, Principal } from './auth';
import { buildRecordEvent, type DomainEvent as WorkflowEvent } from '../lib/domain-event-bus';

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

let engine: WorkflowEngine | null = null;

/**
 * 装载出站白名单。
 * 此前 `setHttpFetchPolicy` 只在测试里调用，生产 allowlist 恒为空，
 * 导致 `http.outbound.fetch` **永远** NOT_ALLOWLISTED（fail-closed 退化成 fail-always）。
 */
async function loadOutboundPolicy(): Promise<void> {
  try {
    const raw = (await SettingsOperations.get('workflow_http_allowlist')) as unknown as
      | string
      | { value?: string }
      | null
      | undefined;
    const value = typeof raw === 'string' ? raw : raw?.value;
    const allowlist = String(value ?? '')
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
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

  void loadOutboundPolicy();

  const dispatcher = createDispatcher({ authorizeDeps });

  engine = new WorkflowEngine({
    listWorkflows: listEnabledDefinitions,
    getWorkflowById: async (id) => {
      const stored = await getStoredById(Number(id));
      return stored ? storedToDefinition(stored) : null;
    },
    canAccessDomain: async (workflow, domain) => {
      if (!workflow.ownerId) return false;
      const access = await getAccessibleDomains(workflow.ownerId);
      // 事件里的 domain.id 可能为 0（如 ns.changed 表无 domain_id），此时按名称判定
      if (domain.id > 0 && access.ids.includes(domain.id)) return true;
      return Boolean(domain.name) && access.names.includes(domain.name);
    },
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
        triggerEvent: run.event,
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