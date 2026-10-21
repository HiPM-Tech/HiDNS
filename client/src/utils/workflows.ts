import type { WorkflowDslNode } from '../api';

/** 条件编辑器与 DSL 之间的纯转换逻辑（页面只负责渲染） */

export interface ConditionField {
  path: string;
  type: 'string' | 'number' | 'boolean';
}

export const CONDITION_FIELDS: ConditionField[] = [
  { path: 'event.record.value', type: 'string' },
  { path: 'event.record.oldValue', type: 'string' },
  { path: 'event.record.name', type: 'string' },
  { path: 'event.record.type', type: 'string' },
  { path: 'event.domain.name', type: 'string' },
  { path: 'event.status', type: 'string' },
  { path: 'event.daysLeft', type: 'number' },
];

export const CONDITION_OPS = ['==', '!=', '>', '>=', '<', '<=', 'in'];

/**
 * 参数值：可以是字面量，也可以引用事件/变量（设计 §3.1 的 `(...)` 形态）。
 * DSL 一直是支持 ref 节点的，此前编辑器只能产出 literal，等于这个能力对用户不可见。
 */
export interface ArgValue {
  kind: 'literal' | 'ref';
  value: string;
}

export interface ActionRow {
  action: string;
  args: Record<string, ArgValue>;
}

export const EMPTY_ROW: ActionRow = { action: '', args: {} };

export interface ConditionRow {
  field: string;
  op: string;
  value: string;
}

export interface ConditionDraft {
  enabled: boolean;
  /** 多条条件之间的连接方式；只有一条时无意义 */
  join: 'and' | 'or';
  rows: ConditionRow[];
  /** 无法用表单无损表达的条件（logic 里混了 arith/cond/ref 等）：原样保留以免保存时被删除 */
  raw?: WorkflowDslNode;
}

export const EMPTY_CONDITION_ROW: ConditionRow = {
  field: CONDITION_FIELDS[0].path,
  op: '==',
  value: '',
};

export const EMPTY_CONDITION: ConditionDraft = {
  enabled: false,
  join: 'and',
  rows: [{ ...EMPTY_CONDITION_ROW }],
};

export function fieldOf(path: string): ConditionField {
  return CONDITION_FIELDS.find((field) => field.path === path) ?? CONDITION_FIELDS[0];
}

/**
 * 按字段类型产出字面量。
 * 一律产出字符串会让 `event.daysLeft == 30` 存成 "30"，严格相等恒为假。
 * `in` 需要数组：把逗号分隔输入拆成 literal 数组。
 */
export function toLiteral(field: ConditionField, op: string, raw: string): WorkflowDslNode {
  if (op === 'in') {
    const items = raw.split(',').map((part) => part.trim()).filter(Boolean);
    return { kind: 'literal', value: items.map((item) => (field.type === 'number' ? Number(item) : item)) };
  }
  // 空字符串不能 Number('') 成 0，否则"清空条件值"会静默变成"等于 0"
  if (field.type === 'number') {
    const trimmed = raw.trim();
    return { kind: 'literal', value: trimmed === '' ? null : Number(trimmed) };
  }
  if (field.type === 'boolean') return { kind: 'literal', value: raw === 'true' };
  return { kind: 'literal', value: raw };
}

/** 单条 compare 节点 → 表单行；无法无损往返时返回 null */
function parseCompareNode(node: WorkflowDslNode): ConditionRow | null {
  if (node.kind !== 'compare') return null;
  const leftNode = (node.left ?? {}) as { kind?: string; path?: string };
  const rightNode = (node.right ?? {}) as { kind?: string; value?: unknown };
  const fieldDef = CONDITION_FIELDS.find((field) => field.path === leftNode.path);
  if (leftNode.kind !== 'ref' || !fieldDef) return null;
  if (rightNode.kind !== 'literal') return null;

  // 只判形状不够：重建字面量走 toLiteral，类型由**字段类型**决定。
  // 原字面量类型与字段类型不一致时（如 string 字段配 boolean 字面量），
  // 往返会把值改写，因此这里要求类型一致才允许结构化。
  const matchesFieldType = (value: unknown): boolean => {
    if (fieldDef.type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (fieldDef.type === 'boolean') return typeof value === 'boolean';
    return typeof value === 'string';
  };
  // 字符串元素还要能被逗号文本无损表示：含逗号 / 首尾空格 / 空串都会被
  // join(', ') → split(',') 破坏，这类必须整节点保留 raw。
  const roundTripSafe = (value: unknown): boolean => {
    if (typeof value !== 'string') return true;
    return value !== '' && value.trim() === value && !value.includes(',');
  };
  const valueTypeOk = Array.isArray(rightNode.value)
    ? node.op === 'in' && rightNode.value.every((item) => matchesFieldType(item) && roundTripSafe(item))
    : node.op === 'in'
      ? false // in 的右值必须是数组，标量会被 toLiteral 改写成 [x]
      : rightNode.value === null
        ? fieldDef.type === 'number'
        : matchesFieldType(rightNode.value);
  if (!valueTypeOk) return null;

  const rawValue = rightNode.value;
  return {
    field: leftNode.path ?? CONDITION_FIELDS[0].path,
    op: String(node.op ?? '=='),
    value: Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue ?? ''),
  };
}

export function toConditionNode(draft: ConditionDraft): WorkflowDslNode | undefined {
  if (!draft.enabled) return undefined;
  // 无法用表单表达的条件原样回传，不能因为「编辑了一下」就把它删掉
  if (draft.raw) return draft.raw;
  const rows = (draft.rows ?? []).filter((row) => row.field);
  if (rows.length === 0) return undefined;
  const nodes: WorkflowDslNode[] = rows.map((row) => ({
    kind: 'compare',
    op: row.op,
    left: { kind: 'ref', path: row.field },
    right: toLiteral(fieldOf(row.field), row.op, row.value),
  }));
  if (nodes.length === 1) return nodes[0];
  // 两条以上用 logic 连接；求值器要求 args 至少 2 个，正好由这里保证
  return { kind: 'logic', op: draft.join, args: nodes };
}

export function fromConditionNode(node: WorkflowDslNode | null | undefined): ConditionDraft {
  if (!node) return { ...EMPTY_CONDITION, rows: [{ ...EMPTY_CONDITION_ROW }] };

  const single = parseCompareNode(node);
  if (single) return { enabled: true, join: 'and', rows: [single] };

  // and/or 组合：每个操作数都必须能无损表达，否则整节点保留 raw。
  // 求值器要求 and/or 至少 2 个操作数，not 恰 1 个——not 不在表单能力内。
  if (node.kind === 'logic' && (node.op === 'and' || node.op === 'or')) {
    const rawArgs = (node as unknown as { args?: unknown }).args;
    const args = Array.isArray(rawArgs) ? (rawArgs as WorkflowDslNode[]) : [];
    if (args.length >= 2) {
      const parsed = args.map((arg) => parseCompareNode(arg));
      if (parsed.every((row): row is ConditionRow => row !== null)) {
        return { enabled: true, join: node.op, rows: parsed };
      }
    }
  }

  return { enabled: true, join: 'and', rows: [{ ...EMPTY_CONDITION_ROW }], raw: node };
}

export function toDslNodes(rows: ActionRow[]): WorkflowDslNode[] {
  return rows
    .filter((row) => row.action)
    .map((row) => {
      const args: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row.args)) {
        if (!value || value.value === '') continue;
        args[key] = value.kind === 'ref'
          ? { kind: 'ref', path: value.value }
          : { kind: 'literal', value: value.value };
      }
      return { kind: 'call', action: row.action, args };
    });
}

export function fromDslNodes(nodes: WorkflowDslNode[] | undefined): ActionRow[] {
  if (!Array.isArray(nodes) || nodes.length === 0) return [{ ...EMPTY_ROW }];
  return nodes.map((node) => {
    const args: Record<string, ArgValue> = {};
    const rawArgs = (node.args ?? {}) as Record<string, { kind?: string; value?: unknown; path?: unknown }>;
    for (const [key, value] of Object.entries(rawArgs)) {
      if (!value || typeof value !== 'object') continue;
      if (value.kind === 'ref') args[key] = { kind: 'ref', value: String(value.path ?? '') };
      else args[key] = { kind: 'literal', value: String(value.value ?? '') };
    }
    return { action: String(node.action ?? ''), args };
  });
}

/** 统一错误描述：优先取服务端 msg，而不是 axios 的 "Request failed with status code 422" */
export function describeError(error: unknown): string {
  const response = (error as { response?: { data?: { msg?: string } } })?.response;
  const serverMsg = response?.data?.msg;
  if (serverMsg) return serverMsg;
  return error instanceof Error ? error.message : String(error);
}
/**
 * 服务端存的是 UTC 的 `YYYY-MM-DD HH:mm:ss`（无时区后缀），
 * 直接 new Date 会按本地时区解析，差出整整一个时区。
 */
export function parseServerTime(raw?: string | null): Date | null {
  const value = String(raw ?? '');
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatServerTime(raw?: string | null): string {
  const date = parseServerTime(raw);
  return date ? date.toLocaleString() : (String(raw ?? '') || '-');
}

/** 耗时：未结束显示 …，用于区分「还在跑」和「没有记录」 */
export function formatDuration(start?: string | null, end?: string | null): string {
  const from = parseServerTime(start);
  if (!from) return '-';
  const to = parseServerTime(end);
  if (!to) return '…';
  const ms = to.getTime() - from.getTime();
  if (!Number.isFinite(ms) || ms < 0) return '-';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** 触发事件摘要：库里存的是 JSON 快照，铺原文没法读 */
export function summarizeTriggerEvent(
  raw: string | null | undefined,
  labelOf: (type: string) => string,
): string {
  if (!raw) return '-';
  try {
    const event = JSON.parse(raw) as {
      type?: string;
      domain?: { name?: string };
      record?: { name?: string; type?: string };
    };
    const parts: string[] = [];
    if (event.type) parts.push(labelOf(String(event.type)));
    if (event.domain?.name) parts.push(event.domain.name);
    if (event.record?.name) parts.push(`${event.record.name}${event.record.type ? ` ${event.record.type}` : ''}`);
    return parts.length ? parts.join(' · ') : '-';
  } catch {
    return '-';
  }
}

/**
 * 找出第一个「必填但没填」的动作参数。
 * 留空的必填项会被 toDslNodes 静默丢弃，工作流照样保存成功、直到运行时才报参数缺失，
 * 所以保存前必须先在本地拦下。
 */
export function findMissingRequiredArg(
  rows: ActionRow[],
  lookup: (action: string) => { params?: Array<{ key: string; required?: boolean }> } | undefined,
): { action: string; param: string } | null {
  for (const row of rows) {
    if (!row.action) continue;
    const meta = lookup(row.action);
    if (!meta) continue;
    for (const param of meta.params ?? []) {
      if (!param.required) continue;
      const value = row.args[param.key];
      // 引用事件字段也是「填了」，只是值要到运行时才确定
      if (!value || String(value.value ?? '').trim() === '') {
        return { action: row.action, param: param.key };
      }
    }
  }
  return null;
}
