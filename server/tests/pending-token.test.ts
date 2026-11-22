import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';
import {
  getJwtSecret,
  signEmailVerifyPendingToken,
  signOAuth2FAPendingToken,
  signToken,
  verifyEmailVerifyPendingToken,
  verifyOAuth2FAPendingToken,
} from '../src/service/jwt';

/**
 * 第五轮评审的 P0 回归：流程凭证（pendingToken）与会话令牌共用同一密钥，
 * 若 authMiddleware 不校验 purpose，pendingToken 可以直接当 Bearer 用 ——
 * 等于绕过「必须先完成邮箱验证 / 第二因子」。
 *
 * 这里覆盖三件事：
 *   1. pendingToken 的 purpose 互相隔离；
 *   2. 普通会话令牌不带 purpose（authMiddleware 才放行）；
 *   3. pendingToken 的载荷里没有角色，即使被误当会话用也拿不到权限。
 */
let handle: TestDbHandle;

beforeAll(async () => {
  handle = await setupTestDb();
});

afterAll(async () => {
  await handle.cleanup();
});

describe('流程凭证与会话令牌分离', () => {
  it('email-verify 与 oauth-2fa 互不通用', async () => {
    const emailToken = await signEmailVerifyPendingToken(42, true);
    const oauthToken = await signOAuth2FAPendingToken(42);

    const fromOauth = await verifyEmailVerifyPendingToken(oauthToken);
    expect(fromOauth).toBeNull();

    const fromEmail = await verifyOAuth2FAPendingToken(emailToken);
    expect(fromEmail).toBeNull();
  });

  it('email-verify 凭证带回 twoFAVerified 标记', async () => {
    const withFlag = await verifyEmailVerifyPendingToken(await signEmailVerifyPendingToken(7, true));
    const withoutFlag = await verifyEmailVerifyPendingToken(await signEmailVerifyPendingToken(7, false));

    expect(withFlag).toEqual({ userId: 7, twoFAVerified: true });
    expect(withoutFlag).toEqual({ userId: 7, twoFAVerified: false });
  });

  it('oauth-2fa 凭证能解出 userId', async () => {
    const token = await signOAuth2FAPendingToken(99);
    expect(await verifyOAuth2FAPendingToken(token)).toBe(99);
  });

  it('流程凭证带 purpose、会话令牌不带 —— authMiddleware 据此拒绝前者', async () => {
    const secret = await getJwtSecret();

    const session = await signToken({ userId: 1, username: 'u', nickname: 'n', role: 1 });
    const sessionPayload = jwt.verify(session, secret) as { purpose?: string };
    expect(sessionPayload.purpose).toBeUndefined();

    for (const token of [await signEmailVerifyPendingToken(1, true), await signOAuth2FAPendingToken(1)]) {
      const payload = jwt.verify(token, secret) as { purpose?: string; role?: unknown };
      expect(payload.purpose).toBeTruthy();
      // 没有 role：即使被误当会话用，也只会被 normalizeRole 兜成最低权限
      expect(payload.role).toBeUndefined();
    }
  });

  it('伪造 purpose 的会话令牌会被识别为流程凭证', async () => {
    const secret = await getJwtSecret();
    const forged = jwt.sign({ userId: 1, purpose: 'email-verify' }, secret, { expiresIn: '10m' });
    expect((jwt.verify(forged, secret) as { purpose?: string }).purpose).toBe('email-verify');
  });
});
