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
  deadline: number;
  /** 运行期节点计数：保存期校验可能被绕过（如历史数据），求值器自己也要有上界 */
  nodes?: number;
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

function checkBudget(state: EvalState, now: () => number): void {
  if (now() > state.deadline) {
    throw new ExpressionError('TIMEOUT', '求值超时');
  }
  // 运行期节点上限：不依赖保存期校验，避免历史/异常数据把求值器拖进深递归
  state.nodes = (state.nodes ?? 0) + 1;
  if (state.nodes > LIMITS.maxNodes) {
    throw new ExpressionError('TOO_MANY_NODES', '表达式节点过多');
  }
}

function compare(op: string, left: unknown, right: unknown): boolean {
  switch (op) {
    case '==': return left === right;
    case '!=': return left !== right;
    case '>': return (left as number) > (right as number);
    case '>=': return (left as number) >= (right as number);
    case '<': return (left as number) < (right as number);
    case '<=': return (left as number) <= (right as number);
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
  checkBudget(st, now);

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
      if (node.op === 'not') {
        return !(await evaluate(node.args[0], ctx, st));
      }
      if (node.op === 'and') {
        for (const arg of node.args) {
          if (!(await evaluate(arg, ctx, st))) return false;
        }
        return true;
      }
      for (const arg of node.args) {
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
      ctx.vars[node.key] = value;
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
      return ctx.call(node.action, args);
    }

    default:
      throw new ExpressionError('UNKNOWN_NODE_KIND', `未知节点: ${(node as { kind?: string }).kind}`);
  }
}