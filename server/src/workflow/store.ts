import { WorkflowOperations, type WorkflowRow } from '../db/bal/business-adapter';
import { createCachedLoader } from './cache';
import { createLogger } from '../lib/logger';

const log = createLogger('Workflow').sub('Store');
import { runPruneScheduler } from './retention';
import type { WorkflowDefinition, WorkflowTrigger } from './engine';
import type { ExpressionNode } from './expression/nodes';

/**
 * 工作流持久化（经 BAL，禁止直连驱动）。
 * 设计依据：§八 数据模型
 */

export class WorkflowStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowStoreError';
  }
}

export interface StoredWorkflow {
  readonly id: number;
  readonly ownerId: number;
  readonly name: string;
  readonly enabled: boolean;
  readonly triggerType: string;
  readonly triggerConfig: Record<string, unknown>;
  readonly condition?: ExpressionNode;
  readonly actions: ExpressionNode[];
}

function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function rowToStored(row: WorkflowRow): StoredWorkflow {
  const definition = safeParse<{ condition?: ExpressionNode; actions?: ExpressionNode[] }>(row.definition, {});
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    enabled: row.enabled === 1,
    triggerType: row.trigger_type,
    triggerConfig: safeParse<Record<string, unknown>>(row.trigger_config, {}),
    condition: definition.condition,
    actions: definition.actions ?? [],
  };
}

export function storedToDefinition(stored: StoredWorkflow): WorkflowDefinition {
  const rawTypes: unknown = stored.triggerConfig.recordTypes;
  const recordTypes: ReadonlyArray<'A' | 'AAAA'> = Array.isArray(rawTypes)
    ? (rawTypes as unknown[]).filter((t): t is 'A' | 'AAAA' => t === 'A' || t === 'AAAA')
    : ['A', 'AAAA'];
  const rawFields = stored.triggerConfig.fields;
  const fields = Array.isArray(rawFields) ? (rawFields as unknown[]).map(String) : undefined;
  const rawStatuses = stored.triggerConfig.statuses;
  const statuses = Array.isArray(rawStatuses) ? (rawStatuses as unknown[]).map(String) : undefined;
  const withinDays =
    typeof stored.triggerConfig.withinDays === 'number' ? stored.triggerConfig.withinDays : undefined;

  let trigger: WorkflowTrigger;
  switch (stored.triggerType) {
    case 'domain.changed':
      trigger = { type: 'domain.changed', fields };
      break;
    case 'ns.changed':
      trigger = { type: 'ns.changed', statuses };
      break;
    case 'whois.expiring':
      trigger = { type: 'whois.expiring', withinDays };
      break;
    case 'record.changed':
      trigger = { type: 'record.changed', recordTypes };
      break;
    default:
      // fail-closed：写坏的 trigger_type 不得降级成「任何 A/AAAA 变动都触发」
      throw new Error('未知的 trigger_type: ' + String(stored.triggerType));
  }

  return {
    id: String(stored.id),
    name: stored.name,
    enabled: stored.enabled,
    ownerId: stored.ownerId,
    trigger,
    condition: stored.condition,
    actions: stored.actions,
  };
}

/** 引擎读取频率高（每个事件一次），用短 TTL 缓存；写操作显式失效 */
const enabledCache = createCachedLoader<WorkflowDefinition[]>(
  async () => {
    const rows = await WorkflowOperations.listEnabled();
    const definitions: WorkflowDefinition[] = [];
    for (const row of rows) {
      try {
        definitions.push(storedToDefinition(rowToStored(row)));
      } catch (error) {
        // 行级隔离：一条坏数据只跳过自己，不能让它拖垮整表导致全部工作流停摆
        log.error('skip malformed workflow row', {
          id: (row as { id?: number }).id,
          error: (error as Error).message,
        });
      }
    }
    return definitions;
  },
  { ttlMs: 5000 },
);

export function invalidateWorkflowCache(): void {
  enabledCache.invalidate();
}

export function listEnabledDefinitions(): Promise<WorkflowDefinition[]> {
  return enabledCache.get();
}

export const workflowCacheStats = () => enabledCache.stats();

export async function listByOwner(ownerId: number): Promise<StoredWorkflow[]> {
  const rows = await WorkflowOperations.listByOwner(ownerId);
  return rows.map(rowToStored);
}

export async function getStoredById(id: number): Promise<StoredWorkflow | null> {
  const row = await WorkflowOperations.getById(id);
  return row ? rowToStored(row) : null;
}

export async function createWorkflow(input: {
  name: string;
  ownerId: number;
  enabled: boolean;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  condition?: ExpressionNode;
  actions: ExpressionNode[];
}): Promise<number> {
  const id = await WorkflowOperations.create({
    name: input.name,
    owner_id: input.ownerId,
    enabled: input.enabled ? 1 : 0,
    trigger_type: input.triggerType,
    trigger_config: JSON.stringify(input.triggerConfig ?? {}),
    definition: JSON.stringify({ condition: input.condition, actions: input.actions }),
  });
  invalidateWorkflowCache();
  return id;
}

export async function updateWorkflow(
  id: number,
  input: {
    name?: string;
    enabled?: boolean;
    triggerType?: string;
    triggerConfig?: Record<string, unknown>;
    condition?: ExpressionNode;
    actions?: ExpressionNode[];
  },
): Promise<void> {
  const patch: Parameters<typeof WorkflowOperations.update>[1] = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.enabled !== undefined) patch.enabled = input.enabled ? 1 : 0;
  if (input.triggerType !== undefined) patch.trigger_type = input.triggerType;
  if (input.triggerConfig !== undefined) patch.trigger_config = JSON.stringify(input.triggerConfig);
  if (input.condition !== undefined || input.actions !== undefined) {
    patch.definition = JSON.stringify({ condition: input.condition, actions: input.actions ?? [] });
  }
  await WorkflowOperations.update(id, patch);
  invalidateWorkflowCache();
}

export async function removeWorkflow(id: number): Promise<void> {
  await WorkflowOperations.remove(id);
  invalidateWorkflowCache();
}

/** 与同表 `created_at` 的 CURRENT_TIMESTAMP 保持一致；MySQL DATETIME 不接受 Z 后缀 */
function toSqlDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace('T', ' ').substring(0, 19);
}

export async function recordRun(record: {
  workflowId: number;
  traceId: string;
  status: string;
  error?: string;
  startedAt: string;
  finishedAt: string;
  /** 触发事件快照，供 `(...)` 预览与追溯 */
  triggerEvent?: unknown;
  depth?: number;
}): Promise<void> {
  let triggerEvent: string | null = null;
  if (record.triggerEvent !== undefined) {
    try {
      triggerEvent = JSON.stringify(record.triggerEvent);
    } catch {
      triggerEvent = null;
    }
  }
  await WorkflowOperations.insertRun({
    workflow_id: record.workflowId,
    trace_id: record.traceId,
    status: record.status,
    error: record.error ?? null,
    trigger_event: triggerEvent,
    depth: record.depth ?? 0,
    started_at: toSqlDateTime(record.startedAt),
    finished_at: toSqlDateTime(record.finishedAt),
  });

  // 保留策略：每写入 N 次清理一次，失败不影响本次记录
  if (runPruneScheduler.onInsert(record.workflowId)) {
    try {
      await WorkflowOperations.pruneRuns(record.workflowId, runPruneScheduler.keep());
    } catch {
      // 清理属于旁路
    }
  }
}

export async function listRuns(workflowId: number, limit = 50) {
  return WorkflowOperations.listRuns(workflowId, limit);
}

/**
 * 取最近一次运行的事件快照，供前端 `(...)` 预览渲染真实值。
 * 没有运行记录时返回 null（前端显示"等待触发"）。
 */
export async function latestSampleEvent(workflowId: number): Promise<Record<string, unknown> | null> {
  const runs = await WorkflowOperations.listRuns(workflowId, 20);
  for (const run of runs) {
    if (!run.trigger_event) continue;
    try {
      return JSON.parse(run.trigger_event) as Record<string, unknown>;
    } catch {
      // 损坏的快照跳过，继续找更早的一条
    }
  }
  return null;
}