import { LIMITS, isSafeRefPath, type ExpressionNode } from './nodes';

/**
 * 声明式求值器：逐节点解释，**不存在 eval / Function / vm**。
 * 设计依据：§6.1 / §6.2 / §6.3
 */

export class ExpressionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ExpressionError';
  }
}

export interface EvalContext {
  readonly event?: Readonly<Record<string, unknown>>;
  readonly vars: Record<string, unknown>;
  /** 动作派发；必须已由 authorize() 授权 */
  readonly call: (action: string, args: Record<string, unknown>) => Promise<unknown>;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export interface EvalState {
  calls: number;
  /** 当前表达式的求值截止时间（**不含**动作执行耗时） */
  deadline: number;
  /** 当前表达式的节点数 */
  nodes?: number;
  /** 本次运行累计节点数（防止用多个根绕过单表达式上界） */
  runNodes?: number;
}

/** 运行级求值状态：一次运行内所有根节点共享同一份预算 */
export function createEvalState(now: () => number = Date.now): EvalState {
  return { calls: 0, deadline: now() + LIMITS.timeoutMs, nodes: 0 };
}

function resolveRef(path: string, ctx: EvalContext): unknown {
  if (!isSafeRefPath(path)) {
    throw new ExpressionError('INVALID_REF', `非法引用: ${path}`);
  }
  const [scope, ...rest] = path.split('.');
  const root = scope === 'event' ? ctx.event : ctx.vars;
  let current: unknown = root;
  for (const segment of rest) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function checkBudget(state: EvalState, now: () => number, signal?: AbortSignal): void {
  // 运行级取消必须能停下求值：否则超时后剩余根节点仍会继续 dispatch
  if (signal?.aborted) {
    throw new ExpressionError('ABORTED', '运行已取消');
  }
  if (now() > state.deadline) {
    throw new ExpressionError('TIMEOUT', '求值超时');
  }
  // 运行期节点上限：不依赖保存期校验，避免历史/异常数据把求值器拖进深递归
  state.nodes = (state.nodes ?? 0) + 1;
  state.runNodes = (state.runNodes ?? 0) + 1;
  if (state.nodes > LIMITS.maxNodes) {
    throw new ExpressionError('TOO_MANY_NODES', '表达式节点过多');
  }
  if (state.runNodes > LIMITS.maxRunNodes) {
    throw new ExpressionError('TOO_MANY_NODES', '本次运行节点总数过多');
  }
}

/** 仅当两边都能安全转成数字时才做数值比较，否则退回字符串比较（ISO 日期等） */
function toComparableNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function relationalCompare(op: string, left: unknown, right: unknown): boolean {
  // 空值一律为假：JS 会把 null 转成 0，导致「30 >= 空」恒真
  if (left === null || left === undefined || right === null || right === undefined) return false;
  const ln = toComparableNumber(left);
  const rn = toComparableNumber(right);
  if (ln !== null && rn !== null) {
    switch (op) {
      case '>': return ln > rn;
      case '>=': return ln >= rn;
      case '<': return ln < rn;
      case '<=': return ln <= rn;
    }
  }
  // 非数值（如 ISO 日期字符串）按字典序比较，与 JS 原生语义一致
  const ls = String(left);
  const rs = String(right);
  switch (op) {
    case '>': return ls > rs;
    case '>=': return ls >= rs;
    case '<': return ls < rs;
    case '<=': return ls <= rs;
  }
  return false;
}

function compare(op: string, left: unknown, right: unknown): boolean {
  switch (op) {
    case '==': return left === right;
    case '!=': return left !== right;
    case '>':
    case '>=':
    case '<':
    case '<=':
      return relationalCompare(op, left, right);
    case 'in':
      if (Array.isArray(right)) return right.includes(left);
      if (right && typeof right === 'object') return Object.prototype.hasOwnProperty.call(right, String(left));
      return false;
    default:
      throw new ExpressionError('INVALID_OPERATOR', `未知比较运算: ${op}`);
  }
}

export async function evaluate(
  node: ExpressionNode,
  ctx: EvalContext,
  state?: EvalState,
): Promise<unknown> {
  const now = ctx.now ?? Date.now;
  const st: EvalState = state ?? { calls: 0, deadline: now() + LIMITS.timeoutMs };
  checkBudget(st, now, ctx.signal);

  switch (node.kind) {
    case 'literal':
      return node.value;

    case 'ref':
      return resolveRef(node.path, ctx);

    case 'compare':
      return compare(node.op, await evaluate(node.left, ctx, st), await evaluate(node.right, ctx, st));

    case 'arith': {
      const left = Number(await evaluate(node.left, ctx, st));
      const right = Number(await evaluate(node.right, ctx, st));
      if (!Number.isFinite(left) || !Number.isFinite(right)) {
        throw new ExpressionError('INVALID_ARITH', '算术运算需要数值');
      }
      switch (node.op) {
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/':
          if (right === 0) throw new ExpressionError('DIVIDE_BY_ZERO', '除数为零');
          return left / right;
        case '%':
          if (right === 0) throw new ExpressionError('DIVIDE_BY_ZERO', '除数为零');
          return left % right;
      }
      throw new ExpressionError('INVALID_OPERATOR', `未知算术运算: ${String((node as { op?: string }).op)}`);
    }

    case 'logic': {
      // 不兜底成 or：op 不是 and/or/not 时直接报错，避免判定被静默反转
      if (node.op !== 'and' && node.op !== 'or' && node.op !== 'not') {
        throw new ExpressionError('INVALID_OPERATOR', `未知逻辑运算: ${String((node as { op?: unknown }).op)}`);
      }
      const args = Array.isArray(node.args) ? node.args : [];
      if (args.length === 0) {
        throw new ExpressionError('INVALID_ARGS', 'logic.args 不能为空');
      }
      if (node.op === 'not') {
        return !(await evaluate(args[0], ctx, st));
      }
      if (node.op === 'and') {
        for (const arg of args) {
          if (!(await evaluate(arg, ctx, st))) return false;
        }
        return true;
      }
      for (const arg of args) {
        if (await evaluate(arg, ctx, st)) return true;
      }
      return false;
    }

    case 'concat': {
      const parts: string[] = [];
      for (const part of node.parts) {
        const value = await evaluate(part, ctx, st);
        parts.push(value === null || value === undefined ? '' : String(value));
      }
      return parts.join('');
    }

    case 'cond':
      return (await evaluate(node.test, ctx, st))
        ? evaluate(node.then, ctx, st)
        : evaluate(node.else, ctx, st);

    case 'assign': {
      const value = await evaluate(node.value, ctx, st);
      // 运行期同样复查：历史数据可能未经保存期校验
      const key = String(node.key ?? '');
      if (!key || key.includes('.') || FORBIDDEN_KEYS.has(key)) {
        throw new ExpressionError('INVALID_ARGS', `非法变量名: ${key}`);
      }
      ctx.vars[key] = value;
      return value;
    }

    case 'call': {
      st.calls += 1;
      if (st.calls > LIMITS.maxCalls) {
        throw new ExpressionError('TOO_MANY_CALLS', `动作调用超过 ${LIMITS.maxCalls} 次`);
      }
      if (typeof node.action !== 'string' || !node.action) {
        throw new ExpressionError('DYNAMIC_ACTION_NAME', 'call.action 必须是字面量');
      }
      const args: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.args)) {
        args[key] = await evaluate(value, ctx, st);
      }
      const result = await ctx.call(node.action, args);
      // 求值时钟只应包含**表达式计算**：动作 I/O 耗时不能算进 5s 求值超时，
      // 否则慢动作之后的节点检查会误报 TIMEOUT（副作用已发生却记失败）。
      st.deadline = (ctx.now ?? Date.now)() + LIMITS.timeoutMs;
      return result;
    }

    default:
      throw new ExpressionError('UNKNOWN_NODE_KIND', `未知节点: ${(node as { kind?: string }).kind}`);
  }
}