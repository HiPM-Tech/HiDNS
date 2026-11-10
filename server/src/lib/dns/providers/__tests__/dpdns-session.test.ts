import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SIGN_COUNTER, WARN_SIGN_COUNTER, ensureSession, loginWithPasskey, nextSignCounter, resolveSessionJar } from '../dpdns_reverse/auth';

/**
 * 会话视图是「新旧凭证共存」的关键：
 * - 新账号：换签后 sessionCookie 完整；
 * - 旧账号：只有当年手抄的 rememberToken（现已移入隐藏字段），过期前仍可用；
 * - 两者都有：以 sessionCookie 为准（它含 panel_session / panel_device）。
 */
describe('resolveSessionJar', () => {
  it('sessionCookie 完整时直接使用', () => {
    const jar = resolveSessionJar({ sessionCookie: 'remember_token=abc; panel_session=s1' });
    expect(jar.get('remember_token')).toBe('abc');
    expect(jar.get('panel_session')).toBe('s1');
  });

  it('只有隐藏字段 rememberToken 时兜底构造 Cookie', () => {
    const jar = resolveSessionJar({ rememberToken: 'legacy-token' });
    expect(jar.get('remember_token')).toBe('legacy-token');
  });

  it('两者同时存在时以 sessionCookie 为准', () => {
    const jar = resolveSessionJar({ sessionCookie: 'remember_token=fresh', rememberToken: 'stale' });
    expect(jar.get('remember_token')).toBe('fresh');
  });

  it('都没有时返回空 map（交给换签流程）', () => {
    expect(resolveSessionJar({}).size).toBe(0);
  });
});

const net = vi.hoisted(() => ({
  calls: [] as string[],
  requestHeaders: [] as Array<Record<string, string>>,
  queue: [] as Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>,
}));

// setup.ts 全局 mock 了 fetchWithFallback（返回固定 {success:true}）；这里覆盖成可编排的假响应
vi.mock('../../../proxy-http', () => ({
  fetchWithFallback: async (url: string, init?: { headers?: Record<string, string> }) => {
    net.calls.push(String(url));
    net.requestHeaders.push((init?.headers ?? {}) as Record<string, string>);
    const next = net.queue.shift() ?? {};
    return new Response(JSON.stringify(next.body ?? { ok: true, user: { id: 1 } }), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    });
  },
  getProxyConfig: async () => null,
}));

describe('ensureSession 的升级兼容路径', () => {
  beforeEach(() => {
    net.calls.length = 0;
    net.requestHeaders.length = 0;
    net.queue.length = 0;
  });

  it('只有旧 rememberToken 且上游返回 200：不换签、直接可用', async () => {
    const config: Parameters<typeof ensureSession>[0] = { rememberToken: 'legacy-token' };
    await ensureSession(config);

    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]).toContain('/api/auth/me');
    // 旧 token 被并入会话 Cookie，后续请求可直接复用
    expect(config.sessionCookie).toContain('remember_token=legacy-token');
    expect(config.rememberToken).toBe('legacy-token');
  });

  it('forcePasskey：即便有旧 rememberToken，也强制用通行密钥换签（不校验旧会话）', async () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const passkey = {
      credentialId: '36d61772-b56f-47b4-9944-65c47be7f611',
      keyValue: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
      rpId: 'dashboard.digitalplat.org',
      userHandle: 'mEqCHdbXrHsyXlUjSh5Cvg-sd0U9qyzISZ1K_a3_2u0',
    };
    net.queue.push(
      { body: { ok: true, csrf_token: 'csrf-1' } },
      { body: { ok: true, options: { challenge: 'chal' }, request_id: 'rid' } },
      {
        body: { ok: true, user: { id: 1 } },
        headers: { 'set-cookie': 'remember_token=brand-new-token; panel_session=s1; panel_device=d1' },
      },
    );

    const config = { rememberToken: 'legacy-token', forcePasskey: true, passkey: JSON.stringify(passkey) };
    await ensureSession(config);

    expect(net.calls.some((u) => u.includes('/auth/me'))).toBe(false);
    expect(net.calls.map((u) => u.split('/_panel_api')[1])).toEqual([
      '/api/security/csrf',
      '/api/auth/passkey/begin',
      '/api/auth/passkey/finish',
    ]);
    expect(config.rememberToken).toBe('brand-new-token');
  });
  it('换签时保留并补齐 panel_csrf_token：header 与 cookie 必须是同一个值', async () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const passkey = {
      credentialId: '36d61772-b56f-47b4-9944-65c47be7f611',
      keyValue: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
      rpId: 'dashboard.digitalplat.org',
      userHandle: 'mEqCHdbXrHsyXlUjSh5Cvg-sd0U9qyzISZ1K_a3_2u0',
    };
    net.queue.push(
      // csrf：只回 body token，不下发 Set-Cookie（用户环境正是这种）
      { body: { ok: true, csrf_token: 'T1' } },
      { body: { ok: true, options: { challenge: 'chal' }, request_id: 'rid' } },
      { body: { ok: true, user: { id: 1 } }, headers: { 'set-cookie': 'remember_token=new; panel_session=s' } },
    );

    const config = {
      passkey: JSON.stringify(passkey),
      sessionCookie: 'remember_token=old; panel_csrf_token=stale',
    };
    await loginWithPasskey(config);

    const beginHeaders = net.requestHeaders[1];
    expect(beginHeaders['X-CSRF-Token']).toBe('T1');
    expect(beginHeaders.Cookie).toContain('panel_csrf_token=T1');
    expect(beginHeaders.Cookie ?? '').not.toContain('remember_token=old');
  });
  it('finish 用 302 下发会话 Cookie 时也能换签成功', async () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const passkey = {
      credentialId: '36d61772-b56f-47b4-9944-65c47be7f611',
      keyValue: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
      rpId: 'dashboard.digitalplat.org',
      userHandle: 'mEqCHdbXrHsyXlUjSh5Cvg-sd0U9qyzISZ1K_a3_2u0',
    };
    net.queue.push(
      { body: { ok: true, csrf_token: 'T1' } },
      { body: { ok: true, options: { challenge: 'chal' }, request_id: 'rid' } },
      { status: 302, body: {}, headers: { 'set-cookie': 'remember_token=rt302' } },
    );

    const config: { passkey: string; rememberToken?: string; sessionCookie?: string } = { passkey: JSON.stringify(passkey) };
    await loginWithPasskey(config);
    expect(config.rememberToken).toBe('rt302');
    expect(config.sessionCookie).toContain('remember_token=rt302');
  });
  it('旧 rememberToken 失效且没有通行密钥：报错并提示补充', async () => {
    net.queue.push({ status: 401, body: { ok: false, error: 'Authentication required' } });
    await expect(ensureSession({ rememberToken: 'expired' })).rejects.toThrow(/通行密钥/);
  });
});

describe('nextSignCounter（对齐 @simplewebauthn/server 语义）', () => {
  it('首次 0：stored=0 且 next=0 时标准库跳过校验', () => {
    expect(nextSignCounter(undefined)).toBe(0);
  });

  it('之后严格 +1，不回绕（回绕会被判为计数器倒退）', () => {
    expect(nextSignCounter(0)).toBe(1);
    expect(nextSignCounter(1)).toBe(2);
    expect(nextSignCounter(299)).toBe(300);
    expect(nextSignCounter(300)).toBe(301);
    expect(nextSignCounter(WARN_SIGN_COUNTER)).toBe(WARN_SIGN_COUNTER + 1);
  });

  it('仅 32 位溢出时回到 1', () => {
    expect(nextSignCounter(MAX_SIGN_COUNTER)).toBe(1);
    expect(nextSignCounter(MAX_SIGN_COUNTER - 1)).toBe(MAX_SIGN_COUNTER);
  });

  it('非法值按 0 处理', () => {
    expect(nextSignCounter(Number.NaN)).toBe(0);
    expect(nextSignCounter(-5)).toBe(0);
  });
});
