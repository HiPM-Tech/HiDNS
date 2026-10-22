import { ALL_ACTIONS } from './actions/registry';
import { validateExpression } from './expression/validate';
import { ALLOWED_TRIGGERS as SHARED_TRIGGERS, DOMAIN_TRIGGERS, DOMAIN_FIELDS, NS_STATUSES } from './triggers';
import type { ExpressionNode } from './expression/nodes';

/**
 * 保存期批量校验（纯函数，无 DB 依赖，便于单测）。
 * 设计依据：§6.3 call.action 静态可判定、§4.0.5 仅 A/AAAA
 */

const KNOWN_ACTIONS = new Set(ALL_ACTIONS.map((a) => a.name));
const ACTION_PARAMS: Record<string, Array<{ key: string; required?: boolean; type?: 'text' | 'number' | 'boolean' | 'select'; options?: readonly string[]; validation?: 'public-origin' | 'must-be-true' }>> = Object.fromEntries(
  ALL_ACTIONS.map((a) => [
    a.name,
    // validation 必须透传：漏了它，must-be-true 的保存期检查会形同虚设
    a.params.map((p) => ({ key: p.key, required: p.required, type: p.type, options: p.options, validation: p.validation })),
  ]),
);

const WRITE_CLASSES = new Set(['dns.record.write', 'ext.write']);

const ACTION_CLASS_BY_NAME = new Map(ALL_ACTIONS.map((a) => [a.name, a.actionClass]));
const ACTION_DSL_VISIBLE = new Map(ALL_ACTIONS.map((a) => [a.name, a.dslVisible]));

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
  // 顶层类型校验：字符串 "false" 曾被当成 true 落库
  if (payload.enabled !== undefined && typeof payload.enabled !== 'boolean') {
    problems.push('enabled 必须是布尔值');
  }
  if (payload.triggerConfig !== undefined) {
    const cfg = payload.triggerConfig;
    if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) {
      problems.push('triggerConfig 必须是对象');
    }
  }
  if (typeof payload.triggerType !== 'string' || !SHARED_TRIGGERS.includes(payload.triggerType as never)) {
    problems.push('triggerType 仅支持 record.changed / domain.changed / ns.changed / whois.expiring');
  }

  const triggerConfig = payload.triggerConfig as { recordTypes?: unknown; fields?: unknown } | undefined;
  // 未知键必须拒绝：拼错（recordType / status / field）会被静默忽略并回落到默认值，
  // 例如 {"recordType":["AAAA"]} 实际变成「A 和 AAAA 都触发」，是静默放大触发面。
  const ALLOWED_CONFIG_KEYS: Record<string, readonly string[]> = {
    'record.changed': ['recordTypes'],
    'domain.changed': ['fields'],
    'ns.changed': ['statuses'],
    'whois.expiring': ['withinDays'],
  };
  if (triggerConfig && typeof triggerConfig === 'object' && !Array.isArray(triggerConfig)) {
    const allowedKeys = ALLOWED_CONFIG_KEYS[String(payload.triggerType)] ?? [];
    const unknownKeys = Object.keys(triggerConfig).filter((key) => !allowedKeys.includes(key));
    if (unknownKeys.length > 0) {
      problems.push(
        `triggerConfig 含未知键: ${unknownKeys.join(', ')}（${String(payload.triggerType)} 仅允许 ${allowedKeys.join(' / ') || '空'}）`,
      );
    }
  }
  const recordTypes = triggerConfig?.recordTypes;
  if (recordTypes !== undefined) {
    if (!Array.isArray(recordTypes)) {
      problems.push('triggerConfig.recordTypes 必须是数组');
    } else if (recordTypes.length === 0) {
      // 设计 §4.0.5：recordTypes 只能取 ['A'] / ['AAAA'] / ['A','AAAA']。
      // 空数组会被引擎判成「永不匹配」——工作流能存下但永远不触发，属于静默失效。
      // 注意与 fields / statuses 不同：那两个空数组表示「任意」，这里表示「一个都不匹配」。
      problems.push('triggerConfig.recordTypes 不能为空：至少选择 A 或 AAAA，否则工作流永远不会触发');
    } else if (recordTypes.some((t) => t !== 'A' && t !== 'AAAA')) {
      problems.push('triggerConfig.recordTypes 仅允许 A / AAAA');
    }
  }
  const fields = triggerConfig?.fields;
  if (fields !== undefined) {
    if (!Array.isArray(fields)) {
      problems.push('triggerConfig.fields 必须是数组');
    } else if (fields.some((f) => !(DOMAIN_FIELDS as readonly string[]).includes(String(f)))) {
      problems.push('triggerConfig.fields 仅允许 remark / is_hidden / enabled');
    }
  }

  const statuses = (triggerConfig as { statuses?: unknown } | undefined)?.statuses;
  if (statuses !== undefined) {
    if (!Array.isArray(statuses)) {
      problems.push('triggerConfig.statuses 必须是数组');
    } else if (statuses.some((s) => !(NS_STATUSES as readonly string[]).includes(String(s)))) {
      problems.push(`triggerConfig.statuses 仅允许 ${NS_STATUSES.join(' / ')}`);
    }
  }

  const withinDays = (triggerConfig as { withinDays?: unknown } | undefined)?.withinDays;
  if (withinDays !== undefined) {
    if (typeof withinDays !== 'number' || !Number.isFinite(withinDays) || withinDays < 0) {
      problems.push('triggerConfig.withinDays 必须是非负数字');
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

  // dslVisible:false 的动作（如 dns.record.delete / batch）不允许被声明式定义表达。
  // 决策：在**保存期**拒绝，而不是只在运行期拦 —— 手动运行执行的正是这份声明，
  // 若保存期放过，dslVisible 的语义就形同虚设。
  const hidden = referencedActions.filter((name) => ACTION_DSL_VISIBLE.get(name) === false);
  if (hidden.length) {
    problems.push(`以下动作不对声明式定义开放: ${[...new Set(hidden)].join(', ')}`);
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