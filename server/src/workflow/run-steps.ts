import { createHash } from 'node:crypto';
import { createLogger } from '../lib/logger';

const log = createLogger('Workflow').sub('Steps');

/**
 * 单次运行里每个动作的执行记录（设计 §3.6：状态、耗时、输入摘要（脱敏）、错误）。
 *
 * 记录的是**求值后**的实参，不是 DSL 里的表达式——这样排查时看到的是真正发给上游的值。
 *
 * 与设计 §1595 的差异（有意为之，记录在此）：
 * - 设计把步骤明细放在独立的 `workflow_run_steps` 表；本实现存为 `workflow_runs.steps` 的 JSON 列。
 *   理由：步骤只随运行记录整体读取、不单独查询，独立表要多一次 join 与一套清理逻辑；
 *   保留策略已由 `workflow/retention.ts` 按运行记录统一执行，JSON 列不会绕过它。
 * - 设计 §1598 的 `input_digest` 是「哈希 + 脱敏字段」，本实现两者都保留：
 *   `input` 是脱敏后的字段（供人看），`inputDigest` 是原始实参的哈希（供比对，不含明文）。
 */
export interface WorkflowRunStep {
  /** 动作全名 */
  action: string;
  status: 'success' | 'failed';
  durationMs: number;
  /**
   * 脱敏后的实参（设计 §1598 的「脱敏字段」）。
   * 注意：**不存明文**——凭据类键名整条遮掉，超长值截断。
   */
  input: Record<string, unknown>;
  /** 原始实参的摘要哈希（设计 §1598 的「哈希」），用于比对两次运行是否传入相同参数 */
  inputDigest: string;
  error?: string;
}

/**
 * 键名命中即视为敏感：宁可多遮，也不要把凭据写进运行记录。
 * 不遮裸 `key`——工作流里 `key` 是变量名（var.workflow.get 的参数），遮了反而查不出问题；
 * 只遮明确的凭据复合词。
 */
const SECRET_KEY = /pass|secret|token|credential|authorization|cookie|apikey|accesskey|privatekey/i;

/** 单个字符串值保留的最大长度，超出截断——避免把整段响应体塞进运行记录 */
const MAX_VALUE_LENGTH = 200;

/**
 * 参数脱敏：
 * - 键名像凭据的整条遮掉；
 * - 超长字符串截断；
 * - 对象/数组折叠成占位，避免把大结构与嵌套凭据带进来。
 */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (SECRET_KEY.test(key)) {
      out[key] = '***';
      continue;
    }
    if (typeof value === 'string') {
      out[key] = value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
      continue;
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      continue;
    }
    out[key] = Array.isArray(value) ? `[${value.length} items]` : '[object]';
  }
  return out;
}

/**
 * 原始实参的摘要。设计 §1598 要求步骤记录里带哈希，便于在不存明文的前提下
 * 判断「两次运行传的参数是否相同」。取前 16 位即可，无需完整 sha256。
 */
export function digestArgs(args: Record<string, unknown>): string {
  try {
    return createHash('sha256').update(JSON.stringify(args ?? {})).digest('hex').slice(0, 16);
  } catch {
    return 'unhashable';
  }
}

/** 序列化供落库；失败时返回 null，绝不让记录动作本身导致运行失败 */
export function serializeSteps(steps: WorkflowRunStep[] | undefined): string | null {
  if (!steps || steps.length === 0) return null;
  try {
    return JSON.stringify(steps);
  } catch (error) {
    log.warn('failed to serialize run steps', { error: (error as Error).message });
    return null;
  }
}
