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

export interface ActionRow {
  action: string;
  args: Record<string, string>;
}

export const EMPTY_ROW: ActionRow = { action: '', args: {} };

export interface ConditionDraft {
  enabled: boolean;
  field: string;
  op: string;
  value: string;
  /** 非 compare 根节点（logic/cond/...）：编辑器无法表达，原样保留以免保存时被删除 */
  raw?: WorkflowDslNode;
}

export const EMPTY_CONDITION: ConditionDraft = {
  enabled: false,
  field: CONDITION_FIELDS[0].path,
  op: '==',
  value: '',
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

export function toConditionNode(draft: ConditionDraft): WorkflowDslNode | undefined {
  if (!draft.enabled) return undefined;
  // 无法用表单表达的条件原样回传，不能因为「编辑了一下」就把它删掉
  if (draft.raw) return draft.raw;
  if (!draft.field) return undefined;
  return {
    kind: 'compare',
    op: draft.op,
    left: { kind: 'ref', path: draft.field },
    right: toLiteral(fieldOf(draft.field), draft.op, draft.value),
  };
}

export function fromConditionNode(node: WorkflowDslNode | null | undefined): ConditionDraft {
  if (!node) return { ...EMPTY_CONDITION };
  const leftNode = (node.left ?? {}) as { kind?: string; path?: string };
  const rightNode = (node.right ?? {}) as { kind?: string; value?: unknown };

  // 只有「表单能无损表达」的条件才结构化：
  //   compare + 左值为白名单字段的 ref + 右值为标量 literal
  // 其余（logic/cond/... 根节点、右值是 ref/concat/arith、左路径不在白名单）
  // 一律整节点保留，否则「打开编辑→保存」会把原节点改写成 literal ""。
  const fieldDef = CONDITION_FIELDS.find((field) => field.path === leftNode.path);
  // 只判形状不够：重建字面量走 toLiteral，类型由**字段类型**决定。
  // 原字面量类型与字段类型不一致时（如 string 字段配 boolean 字面量），
  // 往返会把值改写，因此这里要求类型一致才允许结构化。
  const matchesFieldType = (value: unknown): boolean => {
    if (fieldDef?.type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (fieldDef?.type === 'boolean') return typeof value === 'boolean';
    return typeof value === 'string';
  };
  // `in` 的右值是标量数组：元素逐个校验，保证 join/split 往返无损
  const valueTypeOk = Array.isArray(rightNode.value)
    ? node.op === 'in' && rightNode.value.every((item) => matchesFieldType(item))
    : rightNode.value === null
      ? fieldDef?.type === 'number'
      : matchesFieldType(rightNode.value);
  const lossless =
    node.kind === 'compare' &&
    leftNode.kind === 'ref' &&
    fieldDef !== undefined &&
    rightNode.kind === 'literal' &&
    valueTypeOk;

  if (!lossless) {
    return { ...EMPTY_CONDITION, enabled: true, raw: node };
  }
  const rawValue = rightNode.value;
  const value = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue ?? '');
  return {
    enabled: true,
    field: leftNode.path ?? CONDITION_FIELDS[0].path,
    op: String(node.op ?? '=='),
    value,
  };
}

export function toDslNodes(rows: ActionRow[]): WorkflowDslNode[] {
  return rows
    .filter((row) => row.action)
    .map((row) => {
      const args: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row.args)) {
        if (value === '') continue;
        args[key] = { kind: 'literal', value };
      }
      return { kind: 'call', action: row.action, args };
    });
}

export function fromDslNodes(nodes: WorkflowDslNode[] | undefined): ActionRow[] {
  if (!Array.isArray(nodes) || nodes.length === 0) return [{ ...EMPTY_ROW }];
  return nodes.map((node) => {
    const args: Record<string, string> = {};
    const rawArgs = (node.args ?? {}) as Record<string, { value?: unknown }>;
    for (const [key, value] of Object.entries(rawArgs)) {
      args[key] = value && typeof value === 'object' && 'value' in value ? String(value.value ?? '') : '';
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