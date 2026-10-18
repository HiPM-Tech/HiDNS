import {
  ARITH_OPS,
  COMPARE_OPS,
  LIMITS,
  LOGIC_OPS,
  NODE_KINDS,
  isSafeRefPath,
  type ExpressionNode,
  type NodeKind,
} from './nodes';

/**
 * 保存期静态校验。
 * 设计依据：§6.2 节点白名单、§6.3 限额与 call.action 静态可判定
 *
 * 关键：`call.action` 必须是**字面量字符串**且已注册。
 * 一旦动作名可动态拼接，权限就无法在保存期枚举。
 */

export interface ValidationIssue {
  code: string;
  message: string;
  path: string;
}

export interface ValidationOptions {
  /** 已知动作全名集合 */
  knownActions: ReadonlySet<string>;
  /** 动作参数白名单（key 为动作全名） */
  actionParams?: Readonly<Record<string, readonly string[]>>;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  nodeCount: number;
  maxDepth: number;
  actions: string[];
}

const KIND_SET = new Set<string>(NODE_KINDS);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateExpression(root: unknown, options: ValidationOptions): ValidationResult {
  const issues: ValidationIssue[] = [];
  const actions: string[] = [];
  let nodeCount = 0;
  let maxDepth = 0;

  const visit = (node: unknown, path: string, depth: number): void => {
    nodeCount += 1;
    maxDepth = Math.max(maxDepth, depth);

    if (nodeCount > LIMITS.maxNodes) {
      if (nodeCount === LIMITS.maxNodes + 1) {
        issues.push({ code: 'TOO_MANY_NODES', message: `节点数超过 ${LIMITS.maxNodes}`, path });
      }
      return;
    }
    if (depth > LIMITS.maxDepth) {
      issues.push({ code: 'TOO_DEEP', message: `嵌套超过 ${LIMITS.maxDepth} 层`, path });
      return;
    }
    if (!isObject(node)) {
      issues.push({ code: 'INVALID_NODE', message: '节点必须是对象', path });
      return;
    }

    const kind = node.kind;
    if (typeof kind !== 'string' || !KIND_SET.has(kind)) {
      issues.push({ code: 'UNKNOWN_NODE_KIND', message: `未知节点类型: ${String(kind)}`, path });
      return;
    }

    switch (kind as NodeKind) {
      case 'literal': {
        const value = node.value;
        if (!(value === null || ['string', 'number', 'boolean'].includes(typeof value))) {
          issues.push({ code: 'INVALID_LITERAL', message: 'literal.value 类型非法', path });
        }
        return;
      }
      case 'ref': {
        const refPath = node.path;
        if (typeof refPath !== 'string' || !isSafeRefPath(refPath)) {
          issues.push({ code: 'INVALID_REF', message: `非法的引用路径: ${String(refPath)}`, path });
        }
        return;
      }
      case 'compare': {
        if (!(COMPARE_OPS as readonly string[]).includes(String(node.op))) {
          issues.push({ code: 'INVALID_OPERATOR', message: `比较运算非法: ${String(node.op)}`, path });
        }
        visit(node.left, `${path}.left`, depth + 1);
        visit(node.right, `${path}.right`, depth + 1);
        return;
      }
      case 'arith': {
        if (!(ARITH_OPS as readonly string[]).includes(String(node.op))) {
          issues.push({ code: 'INVALID_OPERATOR', message: `算术运算非法: ${String(node.op)}`, path });
        }
        visit(node.left, `${path}.left`, depth + 1);
        visit(node.right, `${path}.right`, depth + 1);
        return;
      }
      case 'logic': {
        if (!(LOGIC_OPS as readonly string[]).includes(String(node.op))) {
          issues.push({ code: 'INVALID_OPERATOR', message: `逻辑运算非法: ${String(node.op)}`, path });
        }
        const args = node.args;
        if (!Array.isArray(args) || args.length === 0) {
          issues.push({ code: 'INVALID_ARGS', message: 'logic.args 必须是非空数组', path });
        } else {
          args.forEach((arg, index) => visit(arg, `${path}.args[${index}]`, depth + 1));
        }
        return;
      }
      case 'concat': {
        const parts = node.parts;
        if (!Array.isArray(parts) || parts.length === 0) {
          issues.push({ code: 'INVALID_ARGS', message: 'concat.parts 必须是非空数组', path });
        } else {
          parts.forEach((part, index) => visit(part, `${path}.parts[${index}]`, depth + 1));
        }
        return;
      }
      case 'cond': {
        visit(node.test, `${path}.test`, depth + 1);
        visit(node.then, `${path}.then`, depth + 1);
        visit(node.else, `${path}.else`, depth + 1);
        return;
      }
      case 'assign': {
        if (typeof node.key !== 'string' || !node.key) {
          issues.push({ code: 'INVALID_ARGS', message: 'assign.key 必须是非空字符串', path });
        }
        visit(node.value, `${path}.value`, depth + 1);
        return;
      }
      case 'call': {
        const action = node.action;
        if (typeof action !== 'string' || !action) {
          issues.push({
            code: 'DYNAMIC_ACTION_NAME',
            message: 'call.action 必须是字面量动作全名，不得动态拼接',
            path,
          });
          return;
        }
        if (!options.knownActions.has(action)) {
          issues.push({ code: 'UNKNOWN_ACTION', message: `未注册的动作: ${action}`, path });
        }
        const allowed = options.actionParams?.[action];
        const argObj = node.args;
        if (!isObject(argObj)) {
          issues.push({ code: 'INVALID_ARGS', message: 'call.args 必须是对象', path });
        } else {
          if (allowed) {
            for (const key of Object.keys(argObj)) {
              if (!allowed.includes(key)) {
                issues.push({ code: 'UNKNOWN_ARG', message: `${action} 不接受参数 ${key}`, path: `${path}.args.${key}` });
              }
            }
          }
          for (const [key, value] of Object.entries(argObj)) {
            visit(value, `${path}.args.${key}`, depth + 1);
          }
        }
        actions.push(action);
        return;
      }
      default:
        return;
    }
  };

  visit(root, '$', 0);

  return {
    ok: issues.length === 0,
    issues,
    nodeCount,
    maxDepth,
    actions,
  };
}