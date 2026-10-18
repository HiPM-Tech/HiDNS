import { WorkflowOperations, type WorkflowRow } from '../db/bal/business-adapter';
import type { WorkflowDefinition } from './engine';
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
  return {
    id: String(stored.id),
    name: stored.name,
    enabled: stored.enabled,
    trigger: { type: 'record.changed', recordTypes },
    condition: stored.condition,
    actions: stored.actions,
  };
}

export async function listEnabledDefinitions(): Promise<WorkflowDefinition[]> {
  const rows = await WorkflowOperations.listEnabled();
  return rows.map((row) => storedToDefinition(rowToStored(row)));
}

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
  return WorkflowOperations.create({
    name: input.name,
    owner_id: input.ownerId,
    enabled: input.enabled ? 1 : 0,
    trigger_type: input.triggerType,
    trigger_config: JSON.stringify(input.triggerConfig ?? {}),
    definition: JSON.stringify({ condition: input.condition, actions: input.actions }),
  });
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
}

export async function removeWorkflow(id: number): Promise<void> {
  await WorkflowOperations.remove(id);
}

export async function recordRun(record: {
  workflowId: number;
  traceId: string;
  status: string;
  error?: string;
  startedAt: string;
  finishedAt: string;
}): Promise<void> {
  await WorkflowOperations.insertRun({
    workflow_id: record.workflowId,
    trace_id: record.traceId,
    status: record.status,
    error: record.error ?? null,
    started_at: record.startedAt,
    finished_at: record.finishedAt,
  });
}

export async function listRuns(workflowId: number, limit = 50) {
  return WorkflowOperations.listRuns(workflowId, limit);
}