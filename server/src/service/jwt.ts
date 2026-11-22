import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { JwtPayload } from '../types';
import { SecretOperations } from '../db/bal/business-adapter';
import { createLogger } from '../lib/logger';

const log = createLogger('JWT');

const BASE_JWT_SECRET = (() => {
  const secret = process.env.JWT_SECRET;

  if (secret) {
    if (process.env.NODE_ENV === 'production' && secret.length < 32) {
      log.error('JWT_SECRET must be at least 32 characters long in production!');
      process.exit(1);
    }
    return secret;
  }

  const generatedSecret = crypto.randomBytes(32).toString('hex');
  log.warn('JWT_SECRET not set, using randomly generated secret.');
  log.warn('For production, please set JWT_SECRET environment variable to ensure token persistence across restarts.');
  return generatedSecret;
})();

const RUNTIME_SECRET_KEY = 'jwt_runtime';
let runtimeSecretCache: string | null = null;

async function getRuntimeSecret(): Promise<string> {
  if (runtimeSecretCache) return runtimeSecretCache;

  try {
    const value = await SecretOperations.getRuntimeSecret(RUNTIME_SECRET_KEY);
    if (value) {
      runtimeSecretCache = value;
      return value;
    }
  } catch {
    // Table might not exist, will create below
  }

  const generated = crypto.randomBytes(32).toString('hex');

  try {
    await SecretOperations.ensureRuntimeSecretsTable();
    await SecretOperations.setRuntimeSecret(RUNTIME_SECRET_KEY, generated);
  } catch (e) {
    log.error('Error creating runtime_secrets table', { error: e });
  }

  runtimeSecretCache = generated;
  return generated;
}

export async function getJwtSecret(): Promise<string> {
  const runtimeSecret = await getRuntimeSecret();
  return `${BASE_JWT_SECRET}:${runtimeSecret}`;
}

/**
 * 「登录后验证邮箱」的一次性 pending 凭证（10 分钟）。
 *
 * 用途：把 /auth/verify-email 从「知道用户名 + 拿到验证码就能换会话」
 * 收窄为「必须先经过一次密码登录并拿到 -4」。
 */
export async function signEmailVerifyPendingToken(userId: number, twoFAVerified = false): Promise<string> {
  const jwtSecret = await getJwtSecret();
  // twoFAVerified：签发前是否已经通过第二因子。密码登录的 -4 在 2FA 之后，传 true；
  // OAuth 路径不经过 2FA，传 false —— 验证邮箱后仍需补一次 2FA。
  return jwt.sign({ userId, purpose: 'email-verify', twoFAVerified }, jwtSecret, { expiresIn: '10m' });
}

/**
 * OAuth 登录的 2FA 待办凭证（10 分钟）。
 *
 * OAuth 用户通常没有密码，不能复用 /login 的「密码 + 第二因子」流程；
 * 这里用一次性凭证代替密码，交给 /auth/oauth/2fa 完成第二因子。
 */
export async function signOAuth2FAPendingToken(userId: number): Promise<string> {
  const jwtSecret = await getJwtSecret();
  return jwt.sign({ userId, purpose: 'oauth-2fa' }, jwtSecret, { expiresIn: '10m' });
}

export async function verifyOAuth2FAPendingToken(token: string): Promise<number | null> {
  try {
    const jwtSecret = await getJwtSecret();
    const payload = jwt.verify(token, jwtSecret) as { userId?: number; purpose?: string };
    if (payload?.purpose !== 'oauth-2fa' || !payload.userId) return null;
    return Number(payload.userId);
  } catch {
    return null;
  }
}

export async function verifyEmailVerifyPendingToken(
  token: string,
): Promise<{ userId: number; twoFAVerified: boolean } | null> {
  try {
    const jwtSecret = await getJwtSecret();
    const payload = jwt.verify(token, jwtSecret) as { userId?: number; purpose?: string; twoFAVerified?: boolean };
    if (payload?.purpose !== 'email-verify' || !payload.userId) return null;
    return { userId: Number(payload.userId), twoFAVerified: Boolean(payload.twoFAVerified) };
  } catch {
    return null;
  }
}

export async function signToken(payload: JwtPayload): Promise<string> {
  const jwtSecret = await getJwtSecret();
  return jwt.sign(payload, jwtSecret, { expiresIn: '7d' });
}
