import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

vi.mock('../src/service/smtp', () => ({
  sendSmtpEmail: vi.fn(async () => undefined),
}));

import { sendEmailVerificationCode, verifyEmailVerificationCode } from '../src/service/emailVerification';
import { getConnection } from '../src/db/connection';

const sent: string[] = [];

async function latestCode(email: string): Promise<string> {
  // 从测试侧读不回明文（库里只有 hash），所以用「发码时拦截」的方式拿码
  void email;
  return sent[sent.length - 1];
}

describe('邮箱验证码（落库版）', () => {
  let handle: TestDbHandle;

  beforeAll(async () => {
    handle = await setupTestDb();
    const smtp = await import('../src/service/smtp');
    (smtp.sendSmtpEmail as unknown as { mockImplementation: (fn: (to: string, subject: string, body: string) => Promise<void>) => void })
      .mockImplementation(async (_to: string, _subject: string, body: string) => {
        // 正文来自邮件模板（中文），取正文里第一段 6 位数字
        const match = body.match(/(\d{6})/);
        if (match) sent.push(match[1]);
      });
  });
  afterAll(async () => { await handle.cleanup(); });
  beforeEach(() => { sent.length = 0; });

  it('发码后可以用正确验证码校验通过，且只能用一次', async () => {
    await sendEmailVerificationCode(1, 'user@example.com', 'profile');
    const code = await latestCode('user@example.com');
    expect(code).toMatch(/^\d{6}$/);

    await expect(verifyEmailVerificationCode(1, 'user@example.com', code, 'profile')).resolves.toBe(true);
    await expect(verifyEmailVerificationCode(1, 'user@example.com', code, 'profile')).resolves.toBe(false);
  });

  it('错误验证码累加尝试次数，超过 5 次后即使正确也拒绝', async () => {
    await sendEmailVerificationCode(2, 'brute@example.com', 'profile');
    const code = await latestCode('brute@example.com');

    for (let i = 0; i < 5; i += 1) {
      await expect(verifyEmailVerificationCode(2, 'brute@example.com', '000000', 'profile')).resolves.toBe(false);
    }
    await expect(verifyEmailVerificationCode(2, 'brute@example.com', code, 'profile')).resolves.toBe(false);
  });

  it('过期验证码被拒绝', async () => {
    await sendEmailVerificationCode(3, 'expired@example.com', 'profile');
    const code = await latestCode('expired@example.com');
    await getConnection().execute("UPDATE email_verification_codes SET expires_at = '2000-01-01 00:00:00' WHERE email = ?", ['expired@example.com']);
    await expect(verifyEmailVerificationCode(3, 'expired@example.com', code, 'profile')).resolves.toBe(false);
  });

  it('库里不存明文验证码', async () => {
    await sendEmailVerificationCode(4, 'hash@example.com', 'profile');
    const code = await latestCode('hash@example.com');
    const row = await getConnection().get<{ code_hash: string }>('SELECT code_hash FROM email_verification_codes WHERE email = ?', ['hash@example.com']);
    expect(row?.code_hash).toBeTruthy();
    expect(row?.code_hash).not.toBe(code);
    expect(String(row?.code_hash)).toHaveLength(64);
  });
});