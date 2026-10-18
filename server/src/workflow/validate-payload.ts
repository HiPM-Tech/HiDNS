import { ALL_ACTIONS } from './actions/registry';
import { validateExpression } from './expression/validate';
import type { ExpressionNode } from './expression/nodes';

/**
 * 保存期批量校验（纯函数，无 DB 依赖，便于单测）。
 * 设计依据：§6.3 call.action 静态可判定、§4.0.5 仅 A/AAAA
 */

const KNOWN_ACTIONS = new Set(ALL_ACTIONS.map((a) => a.name));
const ACTION_PARAMS: Record<string, string[]> = Object.fromEntries(
  ALL_ACTIONS.map((a) => [a.name, a.params.map((p) => p.key)]),
);

const RECORD_TRIGGERS = new Set(['record.changed']);

export interface WorkflowPayload {
  name?: unknown;
  enabled?: unknown;
  triggerType?: unknown;
  triggerConfig?: unknown;
  condition?: unknown;
  actions?: unknown;
}

export function validatePayload(payload: WorkflowPayload): string[] {
  const problems: string[] = [];

  if (typeof payload.name !== 'string' || payload.name.trim().length === 0) {
    problems.push('name 必填');
  }
  if (typeof payload.triggerType !== 'string' || !RECORD_TRIGGERS.has(payload.triggerType)) {
    problems.push('triggerType 目前仅支持 record.changed');
  }

  const triggerConfig = payload.triggerConfig as { recordTypes?: unknown } | undefined;
  const recordTypes = triggerConfig?.recordTypes;
  if (recordTypes !== undefined) {
    if (!Array.isArray(recordTypes)) {
      problems.push('triggerConfig.recordTypes 必须是数组');
    } else if (recordTypes.some((t) => t !== 'A' && t !== 'AAAA')) {
      problems.push('triggerConfig.recordTypes 仅允许 A / AAAA');
    }
  }

  if (!Array.isArray(payload.actions) || payload.actions.length === 0) {
    problems.push('actions 至少需要一个动作节点');
  }

  const roots: ExpressionNode[] = [];
  if (payload.condition !== undefined) roots.push(payload.condition as ExpressionNode);
  if (Array.isArray(payload.actions)) roots.push(...(payload.actions as ExpressionNode[]));

  for (const root of roots) {
    const result = validateExpression(root, { knownActions: KNOWN_ACTIONS, actionParams: ACTION_PARAMS });
    for (const issue of result.issues) problems.push(`${issue.code}: ${issue.message}`);
  }

  return problems;
}