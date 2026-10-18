/**
 * 声明式 DSL 的节点白名单（封闭枚举）。
 * 设计依据：docs/WORKFLOW_ENGINE_DESIGN.md §6.2
 *
 * 新增节点类型属于规范变更：必须同时更新求值器、保存期校验、前端渲染与 CI 白名单。
 */

export const NODE_KINDS = [
  'literal',
  'ref',
  'compare',
  'logic',
  'arith',
  'concat',
  'cond',
  'call',
  'assign',
] as const;

export type NodeKind = typeof NODE_KINDS[number];

export const COMPARE_OPS = ['==', '!=', '>', '>=', '<', '<=', 'in'] as const;
export const LOGIC_OPS = ['and', 'or', 'not'] as const;
export const ARITH_OPS = ['+', '-', '*', '/', '%'] as const;

export type LiteralValue = string | number | boolean | null;

export interface LiteralNode {
  kind: 'literal';
  value: LiteralValue;
}

export interface RefNode {
  kind: 'ref';
  /** 仅允许 event.* 与 vars.* */
  path: string;
}

export interface CompareNode {
  kind: 'compare';
  op: typeof COMPARE_OPS[number];
  left: ExpressionNode;
  right: ExpressionNode;
}

export interface LogicNode {
  kind: 'logic';
  op: typeof LOGIC_OPS[number];
  args: ExpressionNode[];
}

export interface ArithNode {
  kind: 'arith';
  op: typeof ARITH_OPS[number];
  left: ExpressionNode;
  right: ExpressionNode;
}

export interface ConcatNode {
  kind: 'concat';
  parts: ExpressionNode[];
}

export interface CondNode {
  kind: 'cond';
  test: ExpressionNode;
  then: ExpressionNode;
  else: ExpressionNode;
}

export interface CallNode {
  kind: 'call';
  /** 必须是**字面量**动作全名，保存期即可静态判定（§6.3） */
  action: string;
  args: Record<string, ExpressionNode>;
}

export interface AssignNode {
  kind: 'assign';
  key: string;
  value: ExpressionNode;
}

export type ExpressionNode =
  | LiteralNode
  | RefNode
  | CompareNode
  | LogicNode
  | ArithNode
  | ConcatNode
  | CondNode
  | CallNode
  | AssignNode;

/** 求值限额（§6.3） */
export const LIMITS = {
  maxDepth: 64,
  maxNodes: 2000,
  maxCalls: 50,
  timeoutMs: 5000,
} as const;

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

export function isSafeRefPath(path: string): boolean {
  if (typeof path !== 'string' || !path) return false;
  const segments = path.split('.');
  if (segments.length < 2) return false;
  if (segments[0] !== 'event' && segments[0] !== 'vars') return false;
  return segments.every((segment) => segment && !FORBIDDEN_SEGMENTS.has(segment));
}