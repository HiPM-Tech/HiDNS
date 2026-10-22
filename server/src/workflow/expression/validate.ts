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

export interface ParamMeta {
  key: string;
  required?: boolean;
  type?: 'text' | 'number' | 'boolean' | 'select';
  options?: readonly string[];
  /** 声明式校验：`must-be-true` 表示这是写入前的确认闸门，保存期必须是 true */
  validation?: 'public-origin' | 'must-be-true';
}

export interface ValidationOptions {
  /** 已知动作全名集合 */
  knownActions: ReadonlySet<string>;
  /** 动作参数元数据（key 为动作全名）。**必填**：缺省会让未知参数静默放行 */
  actionParams: Readonly<Record<string, readonly ParamMeta[]>>;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  nodeCount: number;
  maxDepth: number;
  actions: string[];
}

const KIND_SET = new Set<string>(NODE_KINDS);

/** assign.key 禁止使用的原型链段 */
const FORBIDDEN_KEY_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}


/**
 * 旧形态参数的迁移指引（设计 §904 兼容层）。
 *
 * 只给「未知参数」是不够的：用户看到 UNKNOWN_ARG 并不知道该改成什么。
 * 源站组从 domainId 改为 accountId + scopeId 是一次契约变更，必须点明去哪儿查。
 */
function migrationHint(action: string, key: string): string {
  if (!action.startsWith('ext.tencenteo.originGroup.')) return '';
  if (key === 'domainId') {
    return '（源站组已改为账号优先：请改用 accountId + scopeId；' +
      '可调用 GET /api/workflows/migration-report 查看本工作流的迁移建议）';
  }
  if (key === 'zoneId') {
    return '（zoneId 已改名为 scopeId，含义不变）';
  }
  return '';
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
        // 数组字面量用于 `in` 运算（如 status in ['mismatch','missing']），
        // 求值器已支持，校验层必须放行，否则前后端契约自相矛盾。
        if (Array.isArray(value)) {
          if (value.some((item) => !['string', 'number', 'boolean'].includes(typeof item))) {
            issues.push({ code: 'INVALID_LITERAL', message: 'literal.value 数组元素类型非法', path });
          }
          return;
        }
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
        if (typeof node.op !== 'string' || !(COMPARE_OPS as readonly string[]).includes(node.op)) {
          issues.push({ code: 'INVALID_OPERATOR', message: `比较运算非法: ${String(node.op)}`, path });
        }
        visit(node.left, `${path}.left`, depth + 1);
        visit(node.right, `${path}.right`, depth + 1);
        return;
      }
      case 'arith': {
        if (typeof node.op !== 'string' || !(ARITH_OPS as readonly string[]).includes(node.op)) {
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
        // op 必须是字符串：否则 String(['and']) 能过白名单，运行期严格相等落不到 and 分支
        if (typeof node.op !== 'string') {
          issues.push({ code: 'INVALID_ARGS', message: 'logic.op 必须是字符串', path });
          break;
        }
        const expected = node.op === 'not' ? 1 : 2;
        if (!Array.isArray(args) || args.length === 0) {
          issues.push({ code: 'INVALID_ARGS', message: 'logic.args 必须是非空数组', path });
        } else if (node.op === 'not' && args.length !== 1) {
          issues.push({ code: 'INVALID_ARGS', message: 'not 只接受 1 个操作数', path });
        } else if ((node.op === 'and' || node.op === 'or') && args.length < expected) {
          issues.push({ code: 'INVALID_ARGS', message: `${node.op} 至少需要 2 个操作数`, path });
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
        } else if (node.key.includes('.')) {
          issues.push({ code: 'INVALID_ARGS', message: 'assign.key 不得包含点号', path });
        } else if (FORBIDDEN_KEY_SEGMENTS.has(node.key)) {
          issues.push({ code: 'INVALID_ARGS', message: `assign.key 不得使用 ${node.key}`, path });
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
            const allowedKeys = allowed.map((param) => param.key);
            for (const key of Object.keys(argObj)) {
              if (!allowedKeys.includes(key)) {
                issues.push({
                  code: 'UNKNOWN_ARG',
                  message: `${action} 不接受参数 ${key}${migrationHint(action, key)}`,
                  path: `${path}.args.${key}`,
                });
              }
            }
            // 必填参数缺失在保存期就要拦住：否则运行期才抛 400，事件白丢
            for (const param of allowed) {
              if (param.required && argObj[param.key] === undefined) {
                issues.push({ code: 'MISSING_ARG', message: `${action} 缺少必填参数 ${param.key}`, path: `${path}.args.${param.key}` });
              }
            }
            // 写入前的确认闸门：`must-be-true` 的参数在保存期就必须是 true。
            // 之前 collapse 根本没被声明，界面上设不了，动作在运行期**永远**抛
            // COLLAPSE_NOT_ACKNOWLEDGED；现在声明了，但还要在保存期拦住「声明了却没勾」。
            for (const param of allowed) {
              if (param.validation !== 'must-be-true') continue;
              const valueNode = argObj[param.key];
              // 接受真布尔与字符串两种写法：编辑器历史上把布尔存成了 "true"
              const isTrue =
                isObject(valueNode) &&
                valueNode.kind === 'literal' &&
                (valueNode.value === true || valueNode.value === 'true');
              if (!isTrue) {
                issues.push({
                  code: 'MUST_BE_TRUE',
                  message: `${action} 参数 ${param.key} 必须为 true（这是写入前的确认闸门）`,
                  path: `${path}.args.${param.key}`,
                });
              }
            }

            // select 参数若给的是字面量，必须落在候选集合内
            for (const param of allowed) {
              if (param.type !== 'select' || !param.options?.length) continue;
              const valueNode = argObj[param.key];
              if (!isObject(valueNode) || valueNode.kind !== 'literal') continue;
              if (!param.options.includes(String(valueNode.value))) {
                issues.push({
                  code: 'INVALID_OPTION',
                  message: `${action} 参数 ${param.key} 取值不在候选中: ${String(valueNode.value)}`,
                  path: `${path}.args.${param.key}`,
                });
              }
            }
          } else {
            // 未提供参数元数据时视为无允许参数（fail-closed），避免新增调用方静默放行
            issues.push({ code: 'UNKNOWN_ARG', message: `${action} 未声明参数元数据，拒绝任何参数`, path });
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