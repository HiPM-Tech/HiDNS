/**
 * 把后端/网络错误转成用户能看懂的中文。
 *
 * 现状是同一页面混着中文提示与 `Credential check failed`、`getaddrinfo ENOTFOUND ...`
 * 这类原始英文（C 端细节轮 P2）。这里只做「已知模式映射 + 兜底」，不改后端语义。
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/getaddrinfo ENOTFOUND/i, '域名解析失败，请检查目标是否填写正确'],
  [/getaddrinfo EAI_AGAIN/i, 'DNS 解析暂时不可用，请稍后重试'],
  [/ECONNREFUSED/i, '连接被拒绝，目标端口可能未开放'],
  [/ECONNRESET/i, '连接被重置，请稍后重试'],
  [/ETIMEDOUT|timed? ?out/i, '请求超时，请稍后重试'],
  [/Credential check failed/i, '凭据校验失败，请检查账号配置'],
  [/Invalid hostname/i, '主机名不合法'],
  [/Invalid IPv6/i, 'IPv6 地址格式不正确'],
  [/Network Error/i, '网络异常，请检查网络后重试'],
  [/Failed to fetch/i, '网络异常，请检查网络后重试'],
  [/certificate|TLS|SSL/i, '证书或 TLS 握手失败'],
];

export function humanizeError(err: unknown, fallback = '操作失败，请稍后重试'): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const text = raw.trim();
  if (!text) return fallback;
  for (const [re, message] of PATTERNS) {
    if (re.test(text)) return message;
  }
  // 已经是中文就直接用
  if (/[\u4e00-\u9fa5]/.test(text)) return text;
  // 其余英文：保留原始信息但加中文前缀，避免用户只看到一串英文
  return `操作失败：${text.slice(0, 120)}`;
}
