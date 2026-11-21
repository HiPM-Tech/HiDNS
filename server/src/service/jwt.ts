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
export async function signEmailVerifyPendingToken(userId: number): Promise<string> {
  const jwtSecret = await getJwtSecret();
  return jwt.sign({ userId, purpose: 'email-verify' }, jwtSecret, { expiresIn: '10m' });
}

export async function verifyEmailVerifyPendingToken(token: string): Promise<number | null> {
  try {
    const jwtSecret = await getJwtSecret();
    const payload = jwt.verify(token, jwtSecret) as { userId?: number; purpose?: string };
    if (payload?.purpose !== 'email-verify' || !payload.userId) return null;
    return Number(payload.userId);
  } catch {
    return null;
  }
}

export async function signToken(payload: JwtPayload): Promise<string> {
  const jwtSecret = await getJwtSecret();
  return jwt.sign(payload, jwtSecret, { expiresIn: '7d' });
}
