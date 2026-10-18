import { randomUUID } from 'node:crypto';
import { createLogger } from '../lib/logger';
import { isSystemInitialized } from '../service/systemState';
import { AuditOperations, UserOperations } from '../db/bal/business-adapter';
import { AVAILABLE_SERVICES, type AvailableService } from '../types/token';
import { WorkflowEngine, type WorkflowDefinition } from './engine';
import { createDispatcher } from './dispatch';
import { lookupActionMeta } from './actions/registry';
import { listEnabledDefinitions, recordRun } from './store';
import type { AuthorizeDeps, Principal } from './auth';
import type { WorkflowEvent } from './event-bus';

const log = createLogger('Workflow');

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;
const buckets = new Map<string, { count: number; resetAt: number }>();

/** 进程内令牌桶；单实例部署足够，多实例需换 Redis */
export function rateLimit(key: string): boolean {
  const now = Date.now();
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
  return {
    kind: 'user',
    id: String(user.id),
    role: (user.role_level ?? 1) >= 3 ? 'super_admin' : (user.role_level ?? 1) >= 2 ? 'admin' : 'user',
    services: servicesForRole(user.role_level ?? 1),
    allowedDomains: '*',
  };
}

let engine: WorkflowEngine | null = null;

export function startWorkflowModule(): void {
  if (engine) return;
  if (!isSystemInitialized()) {
    log.info('workflow module not started: system not initialized');
    return;
  }

  const dispatcher = createDispatcher({ authorizeDeps });

  engine = new WorkflowEngine({
    listWorkflows: listEnabledDefinitions,
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

export type { WorkflowEvent };