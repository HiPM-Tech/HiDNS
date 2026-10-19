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

/** 把 IPv6 文本解析成 16 字节；非法返回 null */
function ipv6ToBytes(ip: string): number[] | null {
  let normalized = ip.toLowerCase().split('%')[0];
  // 先把内嵌点分 IPv4（::ffff:10.0.0.1）换成两组十六进制，再按 ''::'' 展开计数
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (dotted) {
    const parts = dotted[1].split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hex = `${(((parts[0] << 8) | parts[1]) >>> 0).toString(16)}:${(((parts[2] << 8) | parts[3]) >>> 0).toString(16)}`;
    normalized = normalized.slice(0, normalized.length - dotted[1].length) + hex;
  }
  const [head, tail] = normalized.split('::');
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = tail ? tail.split(':').filter(Boolean) : [];
  const total = headParts.length + tailParts.length;
  if (normalized.includes('::') ? total > 7 : total !== 8) return null;

  const groups: string[] = [...headParts];
  if (normalized.includes('::')) {
    for (let i = 0; i < 8 - total; i += 1) groups.push('0');
  }
  groups.push(...tailParts);

  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}

/**
 * 私网 / 保留 IPv6 判定。
 * 必须按网段比较：字符串前缀法对 `fe80::/10`（febf 也属内网）、
 * `::ffff:a00:1`（WHATWG 会把点分归一化成十六进制）全部漏判。
 */
export function isPrivateIPv6(ip: string): boolean {
  const bytes = ipv6ToBytes(ip);
  if (!bytes) return false;

  const isZero = bytes.every((b) => b === 0);
  if (isZero) return true;
  const isLoopback = bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1;
  if (isLoopback) return true;

  const first = bytes[0];
  const second = bytes[1];
  // fe80::/10
  if (first === 0xfe && (second & 0xc0) === 0x80) return true;
  // fc00::/7
  if ((first & 0xfe) === 0xfc) return true;
  // 2001:db8::/32（文档段）
  if (first === 0x20 && second === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  // 2002::/16（6to4）与 64:ff9b::/96（NAT64）
  if (first === 0x20 && second === 0x02) return true;
  if (first === 0x00 && second === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) return true;
  // ff00::/8 组播与 fec0::/10 站点本地（已废弃但仍应拒绝）
  if (first === 0xff) return true;
  if (first === 0xfe && (second & 0xc0) === 0xc0) return true;
  // 0000::/96 IPv4-compatible（::7f00:1 等）：除 :: 与 ::1 外一律按内网处理
  if (bytes.slice(0, 12).every((b) => b === 0)) {
    const v4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    return isPrivateIPv4(v4);
  }
  // ::ffff:0:0/96（IPv4-mapped）→ 取后 4 字节按 IPv4 判定
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    const v4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    return isPrivateIPv4(v4);
  }
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