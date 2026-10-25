import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, type TestDbHandle } from '../tests/helpers/test-db';

let h: TestDbHandle;
let McpOperations: any;
let checkLoginAllowed: any, recordFailedAttempt: any, clearLoginAttempts: any, updateLoginLimitConfig: any;

beforeAll(async () => {
  h = await setupTestDb();
  const ba = await import('../src/db/bal/business-adapter');
  McpOperations = (ba as any).McpOperations;
  const ll = await import('../src/service/loginLimit');
  checkLoginAllowed = ll.checkLoginAllowed;
  recordFailedAttempt = ll.recordFailedAttempt;
  clearLoginAttempts = ll.clearLoginAttempts;
  updateLoginLimitConfig = ll.updateLoginLimitConfig;
});

afterAll(async () => { await h?.cleanup(); });

describe('A4 授权码原子领取', () => {
  it('同一 code 并发 10 次只成功 1 次', async () => {
    const code = 'probe-code-' + Date.now();
    await McpOperations.createAuthCode({
      code, client_id: 'client-1', user_id: 7,
      redirect_uri: 'https://app.example/cb', scope: 'dns:read',
      expires_at: '2030-01-01 00:00:00',
    });
    const results = await Promise.all(Array.from({ length: 10 }, () => McpOperations.consumeAuthCode(code)));
    const ok = results.filter((r: any) => r !== null);
    console.log('[A4] 并发兑换成功次数 =', ok.length, '/ 10');
    expect(ok.length).toBe(1);
  });

  it('过期码与已用码返回 null', async () => {
    const expired = 'probe-expired-' + Date.now();
    await McpOperations.createAuthCode({
      code: expired, client_id: 'c', user_id: 7, redirect_uri: 'r', scope: null,
      expires_at: '2020-01-01 00:00:00',
    });
    const e = await McpOperations.consumeAuthCode(expired);
    const again = await McpOperations.consumeAuthCode(expired);
    console.log('[A4] 过期码 →', e, '| 再兑换 →', again);
    expect(e).toBeNull();
    expect(again).toBeNull();
  });
});

describe('A5 账号锁按「账号|IP」', () => {
  it('攻击者 5 次失败只锁自己 IP，受害者换 IP 仍可登录', async () => {
    await updateLoginLimitConfig({ enabled: true, maxAttempts: 5, lockoutDuration: 15 });
    const victim = 'victim-' + Date.now() + '@example.com';
    const attackerIp = '203.0.113.9';
    const victimIp = '198.51.100.7';

    let locked = false;
    for (let i = 0; i < 5; i++) {
      const r = await recordFailedAttempt(victim, attackerIp);
      locked = locked || r.locked;
    }
    const attacker = await checkLoginAllowed(victim, attackerIp);
    const realUser = await checkLoginAllowed(victim, victimIp);
    const noIp = await checkLoginAllowed(victim, '');
    console.log('[A5] 5 次失败后 attacker 同 IP →', JSON.stringify(attacker), '| victim 另一 IP →', JSON.stringify(realUser), '| 空 IP →', JSON.stringify(noIp));

    expect(locked).toBe(true);
    expect(attacker.allowed).toBe(false);
    expect(realUser.allowed).toBe(true);
    expect(noIp.allowed).toBe(true);
  });

  it('成功登录只清自己 IP 的计数', async () => {
    await updateLoginLimitConfig({ enabled: true, maxAttempts: 5, lockoutDuration: 15 });
    const user = 'clear-' + Date.now() + '@example.com';
    const ipA = '192.0.2.11';
    const ipB = '192.0.2.12';
    for (let i = 0; i < 5; i++) await recordFailedAttempt(user, ipA);
    for (let i = 0; i < 2; i++) await recordFailedAttempt(user, ipB);
    await clearLoginAttempts(user, ipB);
    const a = await checkLoginAllowed(user, ipA);
    const b = await checkLoginAllowed(user, ipB);
    console.log('[A5] 清 ipB 后 → ipA', JSON.stringify(a), '| ipB', JSON.stringify(b));
    expect(a.allowed).toBe(false);
    expect(b.allowed).toBe(true);
  });
});
