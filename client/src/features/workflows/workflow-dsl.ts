/**
 * 动作 / 条件在「可视化表单」与「DSL」之间的唯一转换层。
 *
 * 为什么单独成模块：
 * - 编辑器里两种表示必须无损互转，转换逻辑放在组件里既没法单测，
 *   也容易在「可视化 → DSL」与「DSL → 可视化」两条路径上写出不一致的口径；
 * - 保存前校验也要用同一份规则，否则会出现「界面看着对、存下去是另一个样」。
 *
 * 不丢字段的两条硬规则：
 * 1) 认不出的节点（非 call、非 assign(call)）原样挂在 raw 上，序列化时逐字回写；
 * 2) 认不出的条件（含 arith / cond / 带逗号的字符串字面量等）不转成表单，
 *    由调用方保持 JSON 编辑，宁可少一个可视化入口也不能改写用户的条件。
 */
import type { WorkflowDslNode } from './workflows-api';

/* ────────────────────────── 动作 ────────────────────────── */

/** 一条动作的表单视图：args 持有原样节点，只有被用户改过的键才会被重写 */
export interface ActionDraftRow {
  /** 动作全名；为空表示还没选动作类型（保存前会被拦下） */
  kind: string;
  args: Record<string, WorkflowDslNode>;
  /** 把这一步的结果存进工作流变量（对应 assign 节点） */
  saveAs?: string;
  /** 表单表达不了的节点：原样保留，序列化时逐字回写 */
  raw?: WorkflowDslNode;
}

function asNode(value: unknown): WorkflowDslNode | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === 'string' && kind ? (value as WorkflowDslNode) : null;
}

function readArgs(raw: unknown): Record<string, WorkflowDslNode> {
  const out: Record<string, WorkflowDslNode> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const node = asNode(value);
    if (node) {
      out[key] = node;
      continue;
    }
    // 手写 JSON 的简写：`"domain": "example.test"` 直接当字面量。
    // 之前这类值被 asNode 判为非法后**静默丢弃**，表现为「DSL 里明明写了域名，
    // 可视化表单里却是空的，保存还报必填」，实时映射看起来像没生效。
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = { kind: 'literal', value };
    }
  }
  return out;
}

/** DSL 节点 → 表单行 */
export function readActionRows(nodes?: WorkflowDslNode[] | null): ActionDraftRow[] {
  return (nodes ?? []).map((node) => {
    if (node.kind === 'call') {
      return { kind: String(node.action ?? ''), args: readArgs(node.args) };
    }
    if (node.kind === 'assign') {
      const inner = asNode(node.value);
      const key = typeof node.key === 'string' ? node.key : '';
      // assign 里只认 call：其它表达式（arith / cond / concat）没法在表单里表达
      if (inner && inner.kind === 'call' && key) {
        return { kind: String(inner.action ?? ''), args: readArgs(inner.args), saveAs: key };
      }
    }
    return { kind: '', args: {}, raw: node };
  });
}

/** 表单行 → DSL 节点（写回编辑器时用） */
export function writeActionNodes(rows: ActionDraftRow[]): WorkflowDslNode[] {
  return rows.map((row) => {
    if (row.raw) return row.raw;
    const args: Record<string, WorkflowDslNode> = {};
    for (const [key, node] of Object.entries(row.args)) {
      // 空字面量不写进 DSL：服务端会把它当成「有值但为空」，
      // 于是必填校验看着通过、运行时才报参数缺失——不如就当没填。
      const value = node.kind === 'literal' ? node.value : undefined;
      if (node.kind === 'literal' && (value === '' || value === null || value === undefined)) continue;
      args[key] = node;
    }
    const call: WorkflowDslNode = { kind: 'call', action: row.kind, args };
    return row.saveAs ? { kind: 'assign', key: row.saveAs, value: call } : call;
  });
}

/** 返回第一个没选动作类型的下标；用于保存前拦截 */
export function findUnnamedAction(rows: ActionDraftRow[]): number | null {
  const index = rows.findIndex((row) => !row.raw && !row.kind.trim());
  return index < 0 ? null : index;
}

export function argIsRef(node?: WorkflowDslNode): boolean {
  return node?.kind === 'ref';
}

export function argRefPath(node?: WorkflowDslNode): string {
  return node?.kind === 'ref' ? String(node.path ?? '') : '';
}

/** 实参的可编辑文本；引用节点返回路径本身（界面上另行标注它是引用） */
export function argText(node?: WorkflowDslNode): string {
  if (!node) return '';
  if (node.kind !== 'literal') return '';
  const value = node.value;
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  return value === null || value === undefined ? '' : String(value);
}

/**
 * 按参数类型产出字面量节点。
 * 数字必须存成 number：存成字符串时服务端按数字比较会全部落空，
 * 而界面上看不出任何异常（这类问题只在运行时暴露）。
 */
export function literalArg(type: string, text: string): WorkflowDslNode {
  if (type === 'number') {
    const trimmed = text.trim();
    const num = Number(trimmed);
    // 非数字原样留着，让服务端校验报错，好过静默改成 NaN
    return { kind: 'literal', value: trimmed !== '' && Number.isFinite(num) ? num : trimmed };
  }
  if (type === 'boolean') return { kind: 'literal', value: text === 'true' };
  return { kind: 'literal', value: text };
}

/**
 * 明显的私网 / 回环地址：只用于界面提前提示，权威判定仍在服务端。
 * 比如源站参数填了 127.0.0.1，服务端会拒绝；等运行完再看到报错就太晚了。
 */
export function looksPrivateOrigin(value: string): boolean {
  const raw = value.trim().toLowerCase();
  if (!raw) return false;
  const bare = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
  if (!bare) return false;
  if (bare === '::1' || bare === '[::1]') return true;
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.local') || bare.endsWith('.internal')) return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  return a === 0 || a === 10 || a === 127
    || (a === 192 && b === 168)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 169 && b === 254);
}

/* ────────────────────────── 条件 ────────────────────────── */

export type ConditionFieldType = 'string' | 'number' | 'boolean';

export interface ConditionField {
  path: string;
  label: string;
  type: ConditionFieldType;
}

/** 常用条件字段：与求值器的 ref 路径一一对应（event.* 由事件构造方定义） */
export const CONDITION_FIELDS: readonly ConditionField[] = [
  { path: 'event.record.value', label: '记录新值', type: 'string' },
  { path: 'event.record.oldValue', label: '记录原值', type: 'string' },
  { path: 'event.record.name', label: '主机记录', type: 'string' },
  { path: 'event.record.fqdn', label: '解析全名', type: 'string' },
  { path: 'event.record.type', label: '记录类型', type: 'string' },
  { path: 'event.domain.name', label: '域名', type: 'string' },
  { path: 'event.status', label: '事件状态', type: 'string' },
  { path: 'event.daysLeft', label: '剩余天数', type: 'number' },
];

export const CONDITION_OPS = ['==', '!=', '>', '>=', '<', '<=', 'in'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export interface ConditionRow {
  field: string;
  op: string;
  value: string;
}

export interface ConditionDraft {
  /** 多条条件之间的连接方式；只有一条时无意义 */
  join: 'and' | 'or';
  /** 整组取反（对应 logic/not） */
  negate: boolean;
  rows: ConditionRow[];
}

export const EMPTY_CONDITION_ROW: ConditionRow = { field: CONDITION_FIELDS[0].path, op: '==', value: '' };
export const EMPTY_CONDITION: ConditionDraft = { join: 'and', negate: false, rows: [{ ...EMPTY_CONDITION_ROW }] };

export function fieldOf(path: string): ConditionField {
  return CONDITION_FIELDS.find((field) => field.path === path) ?? CONDITION_FIELDS[0];
}

/** 条件 JSON 文本 → 节点；空文本表示「无条件」 */
export function parseConditionJson(text: string): { ok: true; node: WorkflowDslNode | null } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, node: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : '不是合法 JSON' };
  }
  const node = asNode(parsed);
  if (!node) return { ok: false, error: '条件必须是带 kind 的对象' };
  return { ok: true, node };
}

export function conditionToJson(node: WorkflowDslNode | null): string {
  return node ? JSON.stringify(node, null, 2) : '';
}

function toLiteral(field: ConditionField, op: string, raw: string): WorkflowDslNode {
  if (op === 'in') {
    const items = raw.split(',').map((part) => part.trim()).filter(Boolean);
    return { kind: 'literal', value: items.map((item) => (field.type === 'number' ? Number(item) : item)) };
  }
  // 空串不能 Number('') 成 0，否则「清空条件值」会静默变成「等于 0」
  if (field.type === 'number') {
    const trimmed = raw.trim();
    return { kind: 'literal', value: trimmed === '' ? null : Number(trimmed) };
  }
  if (field.type === 'boolean') return { kind: 'literal', value: raw === 'true' };
  return { kind: 'literal', value: raw };
}

/** 单条 compare 节点 → 表单行；无法无损往返时返回 null */
function parseCompareRow(node: WorkflowDslNode): ConditionRow | null {
  if (node.kind !== 'compare') return null;
  const left = asNode(node.left) as { kind?: string; path?: string } | null;
  const right = asNode(node.right) as { kind?: string; value?: unknown } | null;
  if (!left || !right) return null;
  const field = CONDITION_FIELDS.find((item) => item.path === left.path);
  if (left.kind !== 'ref' || !field) return null;
  if (right.kind !== 'literal') return null;

  const matchesFieldType = (value: unknown): boolean => {
    if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (field.type === 'boolean') return typeof value === 'boolean';
    return typeof value === 'string';
  };
  // 字符串元素还要能被「逗号 + 空格」文本无损表示：
  // 含逗号、首尾有空白的值会被 join('/') 与 split(',') 改写，这类必须整体保留 JSON
  const roundTripSafe = (value: unknown): boolean => {
    if (typeof value !== 'string') return true;
    return value !== '' && value.trim() === value && !value.includes(',');
  };
  const rawValue = right.value;
  const valueOk = Array.isArray(rawValue)
    ? node.op === 'in' && rawValue.every((item) => matchesFieldType(item) && roundTripSafe(item))
    : node.op === 'in'
      // in 的右值必须是数组：标量会被 toLiteral 改写成 [x]
      ? false
      : rawValue === null
        ? field.type === 'number'
        : matchesFieldType(rawValue) && roundTripSafe(rawValue);
  if (!valueOk) return null;

  return {
    field: left.path ?? CONDITION_FIELDS[0].path,
    op: String(node.op ?? '=='),
    // 空字符串在表单里与「未填」同形，无法往返，交给上层保留 JSON
    value: Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue ?? ''),
  };
}

interface ParsedCondition {
  join: 'and' | 'or';
  negate: boolean;
  rows: ConditionRow[];
}

/** 递归解析：compare / logic(and|or) / logic(not)；任一环节无法无损表达就整体放弃 */
function parseConditionNode(node: WorkflowDslNode): ParsedCondition | null {
  const single = parseCompareRow(node);
  if (single) return { join: 'and', negate: false, rows: [single] };
  if (node.kind !== 'logic') return null;
  const rawArgs = node.args;
  const args = Array.isArray(rawArgs) ? rawArgs.map((item) => asNode(item)).filter((item): item is WorkflowDslNode => item !== null) : [];

  // not：求值器要求恰 1 个操作数；嵌套取反逐层翻转，两层抵消
  if (node.op === 'not') {
    if (args.length !== 1 || !Array.isArray(rawArgs) || rawArgs.length !== 1) return null;
    const inner = parseConditionNode(args[0]);
    return inner ? { ...inner, negate: !inner.negate } : null;
  }
  if (node.op !== 'and' && node.op !== 'or') return null;
  // and/or 求值器要求至少 2 个操作数：单条的 logic 无法原样重建
  if (args.length < 2 || !Array.isArray(rawArgs) || rawArgs.length !== args.length) return null;
  const rows = args.map((arg) => parseCompareRow(arg));
  if (!rows.every((row): row is ConditionRow => row !== null)) return null;
  return { join: node.op, negate: false, rows };
}

/** 条件节点 → 表单草稿；null 表示「无法无损可视化」，调用方应继续用 JSON 编辑 */
export function nodeToDraft(node?: WorkflowDslNode | null): ConditionDraft | null {
  if (!node) return { join: 'and', negate: false, rows: [{ ...EMPTY_CONDITION_ROW }] };
  const parsed = parseConditionNode(node);
  return parsed ? { join: parsed.join, negate: parsed.negate, rows: parsed.rows } : null;
}

/** 表单草稿 → 条件节点；没有有效行时返回 null（= 无条件） */
export function draftToNode(draft: ConditionDraft): WorkflowDslNode | null {
  const rows = draft.rows.filter((row) => row.field && row.op);
  if (rows.length === 0) return null;
  const nodes: WorkflowDslNode[] = rows.map((row) => ({
    kind: 'compare',
    op: row.op,
    left: { kind: 'ref', path: row.field },
    right: toLiteral(fieldOf(row.field), row.op, row.value),
  }));
  // 一条用 compare、多条用 logic 连接：求值器要求 and/or 至少 2 个操作数，正好由这里保证
  const inner: WorkflowDslNode = nodes.length === 1 ? nodes[0] : { kind: 'logic', op: draft.join, args: nodes };
  // 取反包在最外层：求值器要求 not 恰有 1 个操作数
  return draft.negate ? { kind: 'logic', op: 'not', args: [inner] } : inner;
}
