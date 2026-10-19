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

const ALLOWED_TRIGGERS = new Set(['record.changed', 'domain.changed']);
const DOMAIN_TRIGGERS = new Set(['domain.changed']);
const WRITE_CLASSES = new Set(['dns.record.write', 'ext.write']);

const ACTION_CLASS_BY_NAME = new Map(ALL_ACTIONS.map((a) => [a.name, a.actionClass]));

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
  if (typeof payload.triggerType !== 'string' || !ALLOWED_TRIGGERS.has(payload.triggerType)) {
    problems.push('triggerType 仅支持 record.changed / domain.changed');
  }

  const triggerConfig = payload.triggerConfig as { recordTypes?: unknown; fields?: unknown } | undefined;
  const recordTypes = triggerConfig?.recordTypes;
  if (recordTypes !== undefined) {
    if (!Array.isArray(recordTypes)) {
      problems.push('triggerConfig.recordTypes 必须是数组');
    } else if (recordTypes.some((t) => t !== 'A' && t !== 'AAAA')) {
      problems.push('triggerConfig.recordTypes 仅允许 A / AAAA');
    }
  }
  const fields = triggerConfig?.fields;
  if (fields !== undefined) {
    if (!Array.isArray(fields)) {
      problems.push('triggerConfig.fields 必须是数组');
    } else if (fields.some((f) => !['remark', 'is_hidden', 'enabled'].includes(String(f)))) {
      problems.push('triggerConfig.fields 仅允许 remark / is_hidden / enabled');
    }
  }

  if (!Array.isArray(payload.actions) || payload.actions.length === 0) {
    problems.push('actions 至少需要一个动作节点');
  }

  const roots: ExpressionNode[] = [];
  if (payload.condition !== undefined) roots.push(payload.condition as ExpressionNode);
  if (Array.isArray(payload.actions)) roots.push(...(payload.actions as ExpressionNode[]));

  const referencedActions: string[] = [];
  for (const root of roots) {
    const result = validateExpression(root, { knownActions: KNOWN_ACTIONS, actionParams: ACTION_PARAMS });
    for (const issue of result.issues) problems.push(`${issue.code}: ${issue.message}`);
    referencedActions.push(...result.actions);
  }

  // §4.0 保存期强制：域名变动类触发器不得触发任何写动作。
  // 这条必须在**落库前**拦住 —— 否则后续每条运行路径都要重新兜底。
  if (typeof payload.triggerType === 'string' && DOMAIN_TRIGGERS.has(payload.triggerType)) {
    const offending = referencedActions.filter((name) => {
      const actionClass = ACTION_CLASS_BY_NAME.get(name);
      return actionClass ? WRITE_CLASSES.has(actionClass) : false;
    });
    if (offending.length) {
      problems.push(`域名变动不得触发写动作: ${[...new Set(offending)].join(', ')}`);
    }
  }

  return problems;
}