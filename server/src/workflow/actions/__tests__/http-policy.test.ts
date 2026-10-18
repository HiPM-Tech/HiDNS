import { describe, it, expect } from 'vitest';
import {
  validateOutboundUrl,
  matchesAllowlist,
  isPrivateIPv4,
  isPrivateIPv6,
  DEFAULT_HTTP_POLICY,
} from '../http/policy';
import { fetchOutbound, setHttpFetchPolicy, OutboundRejectedError } from '../http/outbound';

const policy = { ...DEFAULT_HTTP_POLICY, allowlist: ['api.ipify.org', '*.example.com'] };

function code(raw: string, p = policy): string | undefined {
  return validateOutboundUrl(raw, p).rejection?.code;
}

describe('出站 SSRF 防护', () => {
  it('拒绝非 https 协议', () => {
    expect(code('http://api.ipify.org')).toBe('PROTOCOL_DENIED');
    expect(code('ftp://api.ipify.org')).toBe('PROTOCOL_DENIED');
    expect(code('file:///etc/passwd')).toBe('PROTOCOL_DENIED');
  });

  it('拒绝 URL 内嵌凭据', () => {
    expect(code('https://user:pass@api.ipify.org')).toBe('CREDENTIALS_IN_URL');
  });

  it('拒绝 IPv4 内网段', () => {
    for (const ip of ['10.0.0.1', '172.16.0.1', '192.168.1.1', '127.0.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1']) {
      expect(isPrivateIPv4(ip)).toBe(true);
    }
    expect(isPrivateIPv4('8.8.8.8')).toBe(false);
  });

  it('拒绝 IPv6 内网段与 IPv4-mapped 绕过', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:10.0.0.1', '2001:db8::1']) {
      expect(isPrivateIPv6(ip)).toBe(true);
    }
    expect(isPrivateIPv6('2606:4700::1111')).toBe(false);
  });

  it('内网地址即使命中白名单也拒绝', () => {
    const wide = { ...DEFAULT_HTTP_POLICY, allowlist: ['*.internal', '127.0.0.1'] };
    expect(code('https://127.0.0.1/x', wide)).toBe('INTERNAL_ADDRESS');
    expect(code('https://localhost/x', wide)).toBe('INTERNAL_ADDRESS');
  });

  it('空白名单 = 全禁（fail-closed）', () => {
    expect(code('https://api.ipify.org', { ...DEFAULT_HTTP_POLICY, allowlist: [] })).toBe('NOT_ALLOWLISTED');
    expect(matchesAllowlist('api.ipify.org', [])).toBe(false);
  });

  it('白名单精确与通配匹配', () => {
    expect(matchesAllowlist('api.ipify.org', policy.allowlist)).toBe(true);
    expect(matchesAllowlist('a.example.com', policy.allowlist)).toBe(true);
    expect(matchesAllowlist('example.com', policy.allowlist)).toBe(true);
    expect(matchesAllowlist('evil-example.com', policy.allowlist)).toBe(false);
    expect(matchesAllowlist('example.com.evil.io', policy.allowlist)).toBe(false);
  });

  it('合法地址通过', () => {
    const result = validateOutboundUrl('https://api.ipify.org/?format=json', policy);
    expect(result.rejection).toBeUndefined();
    expect(result.url?.hostname).toBe('api.ipify.org');
  });
});

describe('出站请求执行', () => {
  it('重定向逐跳校验：跳转到未白名单主机被拒绝', async () => {
    const fetcher = async () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.io/x' } });
    await expect(fetchOutbound('https://api.ipify.org', { policy, fetcher })).rejects.toMatchObject({
      code: 'NOT_ALLOWLISTED',
    });
  });

  it('重定向到内网被拒绝', async () => {
    const fetcher = async () =>
      new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/admin' } });
    await expect(fetchOutbound('https://api.ipify.org', { policy, fetcher })).rejects.toBeInstanceOf(
      OutboundRejectedError,
    );
  });

  it('超过重定向上限被拒绝', async () => {
    const fetcher = async (url: string) =>
      new Response(null, { status: 302, headers: { location: url } });
    await expect(fetchOutbound('https://api.ipify.org', { policy, fetcher })).rejects.toMatchObject({
      code: 'TOO_MANY_REDIRECTS',
    });
  });

  it('响应体超过上限被截断', async () => {
    const fetcher = async () => new Response('x'.repeat(64), { status: 200 });
    const result = await fetchOutbound('https://api.ipify.org', {
      policy: { ...policy, maxBytes: 16 },
      fetcher,
    });
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(16);
  });

  it('默认策略下 setHttpFetchPolicy 生效', async () => {
    setHttpFetchPolicy({ allowlist: ['api.ipify.org'] });
    await expect(fetchOutbound('https://evil.io')).rejects.toMatchObject({ code: 'NOT_ALLOWLISTED' });
    setHttpFetchPolicy({ allowlist: [] });
  });
});