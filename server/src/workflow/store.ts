import { WorkflowOperations, type WorkflowRow } from '../db/bal/business-adapter';
import { createCachedLoader } from './cache';
import { ALLOWED_TRIGGERS } from './triggers';
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
  // definition 解析失败必须视为损坏：回落成 {} 会让该工作流「每次触发都成功但什么都不做」，
  // 而截断/半写入正是最常见的损坏形态。
  let definition: { condition?: ExpressionNode; actions?: ExpressionNode[] };
  try {
    const parsed: unknown = row.definition ? JSON.parse(row.definition) : {};
    // 合法 JSON 但不是普通对象（[] / "x" / 123 / null）同样算损坏，否则 actions=[] 仍会 fail-open
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`definition 必须是 JSON 对象: ${row.id}`);
    }
    definition = parsed as { condition?: ExpressionNode; actions?: ExpressionNode[] };
  } catch (error) {
    throw new Error(`definition 非法: ${row.id} (${(error as Error).message})`);
  }
  // trigger_type 非法同样视为损坏：否则列表显示启用、引擎静默跳过，用户无法察觉。
  if (typeof row.trigger_type === 'string' && !ALLOWED_TRIGGERS.includes(row.trigger_type as never)) {
    throw new Error(`trigger_type 非法: ${row.id} (${row.trigger_type})`);
  }
  // trigger_config 语法损坏同样视为损坏：静默兜底成 {} 会把 recordTypes 放宽为 ['A','AAAA']。
  let triggerConfig: unknown = {};
  if (row.trigger_config) {
    try {
      triggerConfig = JSON.parse(row.trigger_config);
    } catch {
      throw new Error(`trigger_config 不是合法 JSON: ${row.id}`);
    }
  }
  if (typeof triggerConfig !== 'object' || triggerConfig === null || Array.isArray(triggerConfig)) {
    throw new Error(`trigger_config 必须是对象: ${row.id}`);
  }
  // 结构校验：definition 被写坏时宁可抛错（由上层行级容错跳过），
  // 也不要把字符串当 actions 传下去（引擎会逐字符求值，错误信息误导）。
  if (definition.actions !== undefined && !Array.isArray(definition.actions)) {
    throw new Error(`definition.actions 必须是数组: ${row.id}`);
  }
  // condition === null 是 API 的「清空」语义，读回时归一化为 undefined，不判损坏
  if (definition.condition !== undefined && definition.condition !== null && (typeof definition.condition !== 'object' || Array.isArray(definition.condition))) {
    throw new Error(`definition.condition 必须是对象: ${row.id}`);
  }
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    enabled: row.enabled === 1,
    triggerType: row.trigger_type,
    triggerConfig: triggerConfig as Record<string, unknown>,
    // API 契约里 condition:null 表示「清空」，读回时归一化为 undefined，不能判成损坏
    condition: definition.condition ?? undefined,
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
  const items: StoredWorkflow[] = [];
  for (const row of rows) {
    try {
      items.push(rowToStored(row));
    } catch (error) {
      // 行级隔离：坏行**不能静默丢弃** —— 丢弃后用户既看不到也删不掉，只能改库。
      // 这里返回占位项（corrupted 标记），让前端能展示并触发删除。
      log.error('malformed workflow row surfaced as placeholder', {
        id: (row as { id?: number }).id,
        error: (error as Error).message,
      });
      items.push({
        id: Number((row as { id?: number }).id ?? 0),
        ownerId: Number((row as { owner_id?: number }).owner_id ?? 0),
        name: String((row as { name?: string }).name ?? '(损坏)'),
        enabled: false,
        triggerType: 'record.changed',
        triggerConfig: {},
        condition: undefined,
        actions: [],
        corrupted: true,
      } as StoredWorkflow);
    }
  }
  return items;
}

/** 只取归属与名称，不解析 definition：供删除路径在数据损坏时仍能鉴权与清理 */
export async function getWorkflowMetaById(id: number): Promise<{ id: number; ownerId: number } | null> {
  const row = await WorkflowOperations.getById(id);
  if (!row) return null;
  return { id: Number((row as { id?: number }).id ?? 0), ownerId: Number((row as { owner_id?: number }).owner_id ?? 0) };
}

export async function getStoredById(id: number): Promise<StoredWorkflow | null> {
  const row = await WorkflowOperations.getById(id);
  if (!row) return null;
  try {
    return rowToStored(row);
  } catch (error) {
    // 详情路径无法跳过：抛工作流层错误，由路由映射成 422（不要依赖 HTTP 中间件的 AppError）
    throw new WorkflowStoreError('CORRUPTED', `工作流数据损坏（id=${id}）: ${(error as Error).message}`);
  }
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
    } catch (error) {
      // 清理属于旁路，不能影响本次记录，但必须留痕：长期失败会让表无界增长
      log.warn('prune runs failed', { workflowId: record.workflowId, error: (error as Error).message });
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