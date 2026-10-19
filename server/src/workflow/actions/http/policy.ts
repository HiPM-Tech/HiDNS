import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

/**
 * 出站访问策略：协议白名单、域名白名单、内网地址拒绝。
 * 设计依据：docs/WORKFLOW_ENGINE_DESIGN.md §5.5 / §5.5.1
 * 本文件为**纯函数**，不发任何请求，便于针对 SSRF 做穷举测试。
 */

export interface HttpFetchPolicy {
  /** 管理员维护的出站白名单；空数组表示全禁（fail-closed） */
  allowlist: readonly string[];
  allowHttp: boolean;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
}

export const DEFAULT_HTTP_POLICY: HttpFetchPolicy = {
  allowlist: [],
  allowHttp: false,
  maxBytes: 1024 * 1024,
  timeoutMs: 15000,
  maxRedirects: 3,
};

export interface UrlRejection {
  code: string;
  message: string;
}

const PRIVATE_V4 = [
  ["10.0.0.0", "10.255.255.255"],
  ["172.16.0.0", "172.31.255.255"],
  ["192.168.0.0", "192.168.255.255"],
  ["127.0.0.0", "127.255.255.255"],
  ["169.254.0.0", "169.254.255.255"],
  ["0.0.0.0", "0.255.255.255"],
  ["100.64.0.0", "100.127.255.255"],
  ["224.0.0.0", "239.255.255.255"],
  ["240.0.0.0", "255.255.255.255"],
] as const;

function v4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function isPrivateIPv4(ip: string): boolean {
  const value = v4ToInt(ip);
  return PRIVATE_V4.some(([from, to]) => {
    const start = v4ToInt(from);
    const end = v4ToInt(to);
    return value >= start && value <= end;
  });
}

export function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fe80')) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  // IPv4-mapped：::ffff:10.0.0.1
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (normalized.startsWith('2001:db8')) return true;
  return false;
}

function normalizeHost(hostname: string): string {
  const ascii = domainToASCII(hostname.toLowerCase());
  return (ascii || hostname.toLowerCase()).replace(/\.$/, '');
}

export function matchesAllowlist(host: string, allowlist: readonly string[]): boolean {
  if (!allowlist.length) return false;
  return allowlist.some((entry) => {
    const rule = normalizeHost(entry);
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(2);
      return host === suffix || host.endsWith('.' + suffix);
    }
    return host === rule;
  });
}

export function validateOutboundUrl(
  raw: string,
  policy: HttpFetchPolicy = DEFAULT_HTTP_POLICY,
): { url?: URL; rejection?: UrlRejection } {
  if (typeof raw !== 'string' || !raw) {
    return { rejection: { code: 'INVALID_URL', message: 'URL 为空' } };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { rejection: { code: 'INVALID_URL', message: 'URL 无法解析' } };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'https:' && !(policy.allowHttp && protocol === 'http:')) {
    return { rejection: { code: 'PROTOCOL_DENIED', message: `协议不允许: ${protocol}` } };
  }

  if (parsed.username || parsed.password) {
    return { rejection: { code: 'CREDENTIALS_IN_URL', message: 'URL 不得内嵌凭据' } };
  }

  // URL 的 hostname 对 IPv6 字面量会带方括号（"[::1]"），isIP 对其返回 0，
  // 若不剥离，下面的私网判定整段是死代码 —— 实测 https://[::1]/ 会被放行。
  const rawHost = parsed.hostname;
  const host = normalizeHost(
    rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost,
  );
  if (!host) {
    return { rejection: { code: 'INVALID_HOST', message: '主机名为空' } };
  }

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return { rejection: { code: 'INTERNAL_ADDRESS', message: `拒绝本地主机: ${host}` } };
  }

  const ipVersion = isIP(host);
  if (ipVersion === 4 && isPrivateIPv4(host)) {
    return { rejection: { code: 'INTERNAL_ADDRESS', message: `拒绝内网 IPv4: ${host}` } };
  }
  if (ipVersion === 6 && isPrivateIPv6(host)) {
    return { rejection: { code: 'INTERNAL_ADDRESS', message: `拒绝内网 IPv6: ${host}` } };
  }

  if (!matchesAllowlist(host, policy.allowlist)) {
    return { rejection: { code: 'NOT_ALLOWLISTED', message: `主机不在出站白名单: ${host}` } };
  }

  return { url: parsed };
}