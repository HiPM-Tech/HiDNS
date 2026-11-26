import { createLogger } from '../../lib/logger';

const log = createLogger('DNS').sub('Provider').sub('Errors');

/**
 * 把厂商的错误码翻译成「用户能据此改东西」的提示。
 *
 * 背景：阿里云只回 `InvalidParameter.RecordValueInvalid` + 「记录的值不正确」，
 * Cloudflare 只回数字码。这些信息原样透传到前端时，用户唯一能做的只有找管理员看日志。
 * 这里按录制类型与常见原因补一层 hint，并在无法归类时保留原始码，避免信息丢失。
 */
export interface ProviderErrorHint {
  /** 面向用户的简短结论 */
  msg: string;
  /** 下一步检查什么 */
  hint?: string;
  /** 归类：value（值不合法）/ conflict（已存在）/ auth（权限）/ rate（限流）/ unknown */
  kind: 'value' | 'conflict' | 'auth' | 'rate' | 'unknown';
}

export interface ProviderErrorContext {
  providerType?: string;
  recordType?: string;
  value?: string;
  /**
   * 是否把厂商原始错误文本放进 hint。
   *
   * 口径（产品决策）：**管理员（role_level >= 2）可见原文，普通用户不可见**。
   * 原文常带 RequestId / 内部端点 / 鉴权细节，对普通用户是泄露，对管理员是排障必需。
   */
  includeRaw?: boolean;
}

function byteLength(value?: string): number {
  return value ? Buffer.byteLength(value, 'utf8') : 0;
}

const VALUE_RULES: Array<{ test: (ctx: ProviderErrorContext) => boolean; hint: string }> = [
  {
    test: (ctx) => ctx.recordType === 'TXT' && byteLength(ctx.value) > 255,
    hint: 'TXT 单段上限 255 字节，当前内容过长。需要拆成多段，例如 "段1" "段2"',
  },
  {
    test: (ctx) => ctx.recordType === 'SRV' && /\d+\.\d+\.\d+\.\d+/.test(ctx.value ?? ''),
    hint: 'SRV 的目标必须是主机名（例如 sip.example.com），不能填 IP 地址',
  },
  {
    test: (ctx) => ['CNAME', 'MX', 'NS'].includes(ctx.recordType ?? '') && /^\d{1,3}(\.\d{1,3}){3}$/.test((ctx.value ?? '').trim()),
    hint: '这个记录类型的目标必须是主机名，不能填 IP 地址',
  },
  {
    test: (ctx) => ctx.recordType === 'CNAME' && (ctx.value ?? '').trim().endsWith('.'),
    hint: 'CNAME 的值不要带结尾的点（通常厂商会自动处理）',
  },
];

function genericValueHint(ctx: ProviderErrorContext): string {
  for (const rule of VALUE_RULES) {
    if (rule.test(ctx)) return rule.hint;
  }
  return '请检查记录值是否符合该类型的格式（A=IPv4，AAAA=IPv6，CNAME/MX/NS=主机名，SRV=优先级 权重 端口 目标）';
}

/**
 * 根据厂商原始错误归类。匹配不上时返回 unknown，并保留原始错误文本。
 */
export function describeProviderError(raw: string | undefined, ctx: ProviderErrorContext = {}): ProviderErrorHint {
  const text = (raw ?? '').trim();
  const lower = text.toLowerCase();

  if (!text) {
    return { msg: '厂商未返回具体原因', hint: '请重试；若持续失败请查看服务端日志', kind: 'unknown' };
  }

  // 值不合法
  if (
    lower.includes('recordvalueinvalid')
    || lower.includes('记录的值不正确')
    || lower.includes('invalid content')
    || lower.includes('9003')
    || lower.includes('81044')
    || lower.includes('记录值非法')
  ) {
    return { msg: '记录值被厂商拒绝', hint: genericValueHint(ctx), kind: 'value' };
  }

  // 重复
  if (
    lower.includes('domainrecordduplicate')
    || lower.includes('already exists')
    || lower.includes('81057')
    || lower.includes('记录已存在')
  ) {
    return { msg: '同名同类型的记录已存在', hint: '请先修改或删除已有记录，厂商不允许完全重复的记录', kind: 'conflict' };
  }

  // 权限 / 凭据
  if (lower.includes('forbidden') || lower.includes('unauthorized') || lower.includes('invalidaccesskeyid') || lower.includes('signature')) {
    return { msg: '厂商拒绝了这些凭据', hint: '请检查该账号的 AccessKey / Token 是否有效、是否有该域名的解析权限', kind: 'auth' };
  }

  // 限流
  if (lower.includes('throttl') || lower.includes('ratelimit') || lower.includes('too many requests') || lower.includes('qps')) {
    return { msg: '触发了厂商的调用频率限制', hint: '稍后重试；批量操作建议降低并发', kind: 'rate' };
  }

  // 厂商原文常带 RequestId、内部端点、鉴权失败细节。这是面向普通用户的披露面，
  // 不是管理员界面 —— 原文只进服务端日志，响应里给一句可执行的下一步。
  log.warn('Unclassified provider error', { raw: text.slice(0, 300), context: ctx });
  return {
    msg: '厂商返回了未分类的错误',
    hint: ctx.includeRaw
      ? `厂商原文：${text.slice(0, 300)}`
      : '请重试；若持续失败，把大致时间点提供给管理员，服务端日志里有厂商原始错误',
    kind: 'unknown',
  };
}