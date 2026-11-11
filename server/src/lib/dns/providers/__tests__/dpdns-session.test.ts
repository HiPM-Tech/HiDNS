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
  usedProxy: [] as boolean[],
  queue: [] as Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>,
}));

// setup.ts 全局 mock 了 fetchWithFallback（返回固定 {success:true}）；这里覆盖成可编排的假响应
vi.mock('../../../proxy-http', () => ({
  fetchWithFallback: async (url: string, init?: { headers?: Record<string, string> }, useProxy?: boolean) => {
    net.calls.push(String(url));
    net.requestHeaders.push((init?.headers ?? {}) as Record<string, string>);
    net.usedProxy.push(Boolean(useProxy));
    const next = net.queue.shift() ?? {};
    return new Response(JSON.stringify(next.body ?? { ok: true, user: { id: 1 } }), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    });
  },
  getProxyConfig: async () => null,
}));

// 所有用例共享同一份 mock 状态：在每个 describe 之前统一清，避免调用记录串味
beforeEach(() => {
  net.calls.length = 0;
  net.requestHeaders.length = 0;
  net.usedProxy.length = 0;
  net.queue.length = 0;
});

describe('ensureSession 的升级兼容路径', () => {

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
    const paths = net.calls.map((u) => u.split('/_panel_api')[1]);
    expect(paths.slice(0, 3)).toEqual([
      '/api/security/csrf',
      '/api/auth/passkey/begin',
      '/api/auth/passkey/finish',
    ]);
    // 换签成功后会再取一次 CSRF（与服务端新会话配对）
    expect(paths[3]).toBe('/api/security/csrf');
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
  it('首次从 1 开始：严格实现要求 next > 0，SimpleWebAuthn 要求 next > stored=0，两者都过', () => {
    expect(nextSignCounter(undefined)).toBe(1);
    expect(nextSignCounter(0)).toBe(1);
  });

  it('之后严格 +1，不回绕（回绕会被判为计数器倒退）', () => {
    expect(nextSignCounter(1)).toBe(2);
    expect(nextSignCounter(299)).toBe(300);
    expect(nextSignCounter(300)).toBe(301);
    expect(nextSignCounter(WARN_SIGN_COUNTER)).toBe(WARN_SIGN_COUNTER + 1);
  });

  it('仅 32 位溢出时回到 1', () => {
    expect(nextSignCounter(MAX_SIGN_COUNTER)).toBe(1);
    expect(nextSignCounter(MAX_SIGN_COUNTER - 1)).toBe(MAX_SIGN_COUNTER);
  });

  it('非法值按首次处理（返回 1）', () => {
    expect(nextSignCounter(Number.NaN)).toBe(1);
    expect(nextSignCounter(-5)).toBe(1);
  });
});

describe('signCount 与凭据绑定', () => {
  function pushSwapResponses() {
    net.queue.push(
      { body: { ok: true, csrf_token: 'T1' } },
      { body: { ok: true, options: { challenge: 'chal' }, request_id: 'rid' } },
      { body: { ok: true, user: { id: 1 } }, headers: { 'set-cookie': 'remember_token=rt' } },
    );
  }

  function makePasskey(credentialId: string) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return {
      credentialId,
      keyValue: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
      rpId: 'dashboard.digitalplat.org',
      userHandle: 'mEqCHdbXrHsyXlUjSh5Cvg-sd0U9qyzISZ1K_a3_2u0',
    };
  }

  it('换了凭据：计数从 1 重新开始（不沿用旧游标）', async () => {
    const passkey = makePasskey('2b2912f3-4d07-4144-8f59-bacd6793f78a');
    pushSwapResponses();
    const config: { passkey: string; signCounter?: number; signCounterFor?: string } = {
      passkey: JSON.stringify(passkey),
      signCounter: 50,
      signCounterFor: '36d61772-b56f-47b4-9944-65c47be7f611',
    };
    await loginWithPasskey(config);
    expect(config.signCounter).toBe(1);
    expect(config.signCounterFor).toBe(passkey.credentialId);
  });

  it('同一凭据：在旧游标上继续 +1', async () => {
    const passkey = makePasskey('2b2912f3-4d07-4144-8f59-bacd6793f78a');
    pushSwapResponses();
    const config: { passkey: string; signCounter?: number; signCounterFor?: string } = {
      passkey: JSON.stringify(passkey),
      signCounter: 50,
      signCounterFor: passkey.credentialId,
    };
    await loginWithPasskey(config);
    expect(config.signCounter).toBe(51);
  });
});


describe('跨版本升级：有 signCounter 但没有 signCounterFor', () => {
  it('沿用旧游标（无法判定是否换凭据时，重置反而会撞上「next > stored」）', async () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const passkey = {
      credentialId: '2b2912f3-4d07-4144-8f59-bacd6793f78a',
      keyValue: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
      rpId: 'dashboard.digitalplat.org',
      userHandle: 'mEqCHdbXrHsyXlUjSh5Cvg-sd0U9qyzISZ1K_a3_2u0',
    };
    net.queue.push(
      { body: { ok: true, csrf_token: 'T1' } },
      { body: { ok: true, options: { challenge: 'chal' }, request_id: 'rid' } },
      { body: { ok: true, user: { id: 1 } }, headers: { 'set-cookie': 'remember_token=rt' } },
    );

    const config = { passkey: JSON.stringify(passkey), signCounter: 50 } as {
      passkey: string; signCounter?: number; signCounterFor?: string;
    };
    await loginWithPasskey(config);
    expect(config.signCounter).toBe(51);
    expect(config.signCounterFor).toBe(passkey.credentialId);
  });

  it('旧账号从未换过签（无 signCounter）：首次换签从 1 开始', async () => {
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
      { body: { ok: true, user: { id: 1 } }, headers: { 'set-cookie': 'remember_token=rt' } },
    );

    const config = { passkey: JSON.stringify(passkey) } as { passkey: string; signCounter?: number };
    await loginWithPasskey(config);
    expect(config.signCounter).toBe(1);
  });
});


describe('CSRF 取值顺序与代理回退', () => {
  beforeEach(() => {
    net.calls.length = 0;
    net.requestHeaders.length = 0;
    net.usedProxy.length = 0;
    net.queue.length = 0;
  });

  function makePasskey() {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return {
      credentialId: '36d61772-b56f-47b4-9944-65c47be7f611',
      keyValue: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
      rpId: 'dashboard.digitalplat.org',
      userHandle: 'mEqCHdbXrHsyXlUjSh5Cvg-sd0U9qyzISZ1K_a3_2u0',
    };
  }

  it('body 与 cookie 不同值时以 body 为准，并同步回 cookie（header 与 cookie 同值）', async () => {
    net.queue.push(
      { body: { ok: true, csrf_token: 'BODY_TOKEN' }, headers: { 'set-cookie': 'panel_csrf_token=COOKIE_TOKEN' } },
      { body: { ok: true, options: { challenge: 'chal' }, request_id: 'rid' } },
      { body: { ok: true, user: { id: 1 } }, headers: { 'set-cookie': 'remember_token=rt' } },
    );

    const config = { passkey: JSON.stringify(makePasskey()) };
    await loginWithPasskey(config);

    const beginHeaders = net.requestHeaders[1];
    expect(beginHeaders['X-CSRF-Token']).toBe('BODY_TOKEN');
    expect(beginHeaders.Cookie).toContain('panel_csrf_token=BODY_TOKEN');
  });

  it('代理没带回 Set-Cookie 时直连重试一次', async () => {
    net.queue.push(
      { body: { ok: true, csrf_token: 'T_NO_COOKIE' } },                       // 代理：无 Set-Cookie
      { body: { ok: true, csrf_token: 'T_DIRECT' }, headers: { 'set-cookie': 'panel_csrf_token=T_DIRECT' } }, // 直连
      { body: { ok: true, options: { challenge: 'chal' }, request_id: 'rid' } },
      { body: { ok: true, user: { id: 1 } }, headers: { 'set-cookie': 'remember_token=rt' } },
    );

    const config = { passkey: JSON.stringify(makePasskey()), useProxy: true };
    await loginWithPasskey(config);

    // 前两次都是 csrf：第一次走代理，第二次直连
    expect(net.usedProxy[0]).toBe(true);
    expect(net.usedProxy[1]).toBe(false);
    expect(net.requestHeaders[2]['X-CSRF-Token']).toBe('T_DIRECT');
  });
});


describe('Set-Cookie 合并串解析（fetch 的真实形态）', () => {
  function makePasskey() {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return {
      credentialId: '36d61772-b56f-47b4-9944-65c47be7f611',
      keyValue: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
      rpId: 'dashboard.digitalplat.org',
      userHandle: 'mEqCHdbXrHsyXlUjSh5Cvg-sd0U9qyzISZ1K_a3_2u0',
    };
  }

  it('逗号后没有空格时也能拿到第二个 cookie（panel_csrf_token）', async () => {
    net.queue.push(
      {
        body: { ok: true, csrf_token: 'CSRF_COOKIE' },
        headers: { 'set-cookie': 'remember_token=rt; Path=/,panel_csrf_token=CSRF_COOKIE; Path=/' },
      },
      { body: { ok: true, options: { challenge: 'chal' }, request_id: 'rid' } },
      { body: { ok: true, user: { id: 1 } }, headers: { 'set-cookie': 'remember_token=rt2' } },
    );

    const config: { passkey: string; sessionCookie?: string; csrfToken?: string } = { passkey: JSON.stringify(makePasskey()) };
    await loginWithPasskey(config);

    expect(config.sessionCookie).toContain('panel_csrf_token=CSRF_COOKIE');
    expect(net.requestHeaders[1]['X-CSRF-Token']).toBe('CSRF_COOKIE');
  });

  it('带 Expires 属性时不会被逗号误切', async () => {
    net.queue.push(
      {
        body: { ok: true, csrf_token: 'CSRF2' },
        headers: {
          'set-cookie': 'remember_token=rt; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, panel_csrf_token=CSRF2; Path=/',
        },
      },
      { body: { ok: true, options: { challenge: 'chal' }, request_id: 'rid' } },
      { body: { ok: true, user: { id: 1 } }, headers: { 'set-cookie': 'remember_token=rt2' } },
    );

    const config: { passkey: string; sessionCookie?: string } = { passkey: JSON.stringify(makePasskey()) };
    await loginWithPasskey(config);
    expect(config.sessionCookie).toContain('panel_csrf_token=CSRF2');
  });
});


describe('signCount 自愈（服务端 counter 与本地不同步）', () => {
  function makePasskey() {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return {
      credentialId: '02c3ace8-6a41-48e0-bfff-a66c448ad1a0',
      keyValue: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
      rpId: 'dashboard.digitalplat.org',
      userHandle: 'mEqCHdbXrHsyXlUjSh5Cvg-sd0U9qyzISZ1K_a3_2u0',
    };
  }

  it('第一次 could not be verified，用下一个候选值重试并成功', async () => {
    const passkey = makePasskey();
    net.queue.push(
      // attempt 1
      { body: { ok: true, csrf_token: 'T1' } },
      { body: { ok: true, options: { challenge: 'c1' }, request_id: 'r1' } },
      { status: 401, body: { ok: false, code: 'security_error', error: 'Passkey sign-in could not be verified.' } },
      // attempt 2
      { body: { ok: true, csrf_token: 'T2' } },
      { body: { ok: true, options: { challenge: 'c2' }, request_id: 'r2' } },
      { body: { ok: true, user: { id: 1 } }, headers: { 'set-cookie': 'remember_token=rt' } },
      // 成功后刷新 CSRF
      { body: { ok: true, csrf_token: 'T3' } },
    );

    const config: { passkey: string; signCounter?: number; signCounterFor?: string } = { passkey: JSON.stringify(passkey) };
    await loginWithPasskey(config);

    // base=1 → 第一次失败 → 第二个候选是时间戳（保证大于任何历史 stored）
    expect(config.signCounter).toBeGreaterThan(1000);
    expect(config.signCounterFor).toBe(passkey.credentialId);
    const csrfCalls = net.calls.filter((u) => u.includes('/api/security/csrf'));
    expect(csrfCalls).toHaveLength(3);
  });

  it('凭据不存在（sign-in failed）不重试，直接失败', async () => {
    const passkey = makePasskey();
    net.queue.push(
      { body: { ok: true, csrf_token: 'T1' } },
      { body: { ok: true, options: { challenge: 'c1' }, request_id: 'r1' } },
      { status: 401, body: { ok: false, code: 'security_error', error: 'Passkey sign-in failed.' } },
    );

    await expect(loginWithPasskey({ passkey: JSON.stringify(passkey) })).rejects.toThrow(/sign-in failed/);
    expect(net.calls.filter((u) => u.includes('/api/security/csrf'))).toHaveLength(1);
  });
});


  it('固定上限会死循环：候选用时间戳跨过任意历史值', async () => {
    const passkey = (() => {
      const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      return {
        credentialId: '02c3ace8-6a41-48e0-bfff-a66c448ad1a0',
        keyValue: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
        rpId: 'dashboard.digitalplat.org',
        userHandle: 'mEqCHdbXrHsyXlUjSh5Cvg-sd0U9qyzISZ1K_a3_2u0',
      };
    })();

    // 第一次用 base 失败，第二次必须用一个「远大于历史」的值并成功
    net.queue.push(
      { body: { ok: true, csrf_token: 'T1' } },
      { body: { ok: true, options: { challenge: 'c1' }, request_id: 'r1' } },
      { status: 401, body: { ok: false, code: 'security_error', error: 'Passkey sign-in could not be verified.' } },
      { body: { ok: true, csrf_token: 'T2' } },
      { body: { ok: true, options: { challenge: 'c2' }, request_id: 'r2' } },
      { body: { ok: true, user: { id: 1 } }, headers: { 'set-cookie': 'remember_token=rt' } },
      { body: { ok: true, csrf_token: 'T3' } },
    );

    const config: { passkey: string; signCounter?: number; signCounterFor?: string } = {
      passkey: JSON.stringify(passkey),
      signCounter: 33,
      signCounterFor: passkey.credentialId,
    };
    await loginWithPasskey(config);

    const now = Math.floor(Date.now() / 1000);
    expect(config.signCounter).toBeGreaterThanOrEqual(now - 2);
    expect(config.signCounter).toBeGreaterThan(1000);
  });

