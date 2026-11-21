import crypto from 'crypto';
import { EmailVerificationOperations } from '../db/bal/business-adapter';
import { createLogger } from '../lib/logger';
import { sendSmtpEmail } from './smtp';

/**
 * 邮箱验证码（issue #43 C1）。
 *
 * 与旧实现的区别：
 * - 落库而不是进程内 Map（重启/多实例不丢、可审计）；
 * - 只存 sha256(code)，库里看不到明文；
 * - 单次使用 + 5 次尝试上限（旧实现可无限试 6 位码）；
 * - 过期与清理按 DB 时间比较，避免应用时区问题。
 */
const log = createLogger('Service').sub('EmailVerification');
const TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export type VerificationPurpose = 'profile' | 'login';

/** 与 SQLite 的 datetime('now') 对齐：YYYY-MM-DD HH:MM:SS（UTC） */
function toDbDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function randomCode(): string {
  return String(crypto.randomInt(100000, 1000000));
}

export async function sendEmailVerificationCode(
  userId: number | null,
  email: string,
  purpose: VerificationPurpose = 'profile',
): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const code = randomCode();
  const now = new Date();
  const expiresAt = toDbDateTime(new Date(now.getTime() + TTL_MS));

  // 顺手清理过期/已用的旧记录，避免表无限增长
  await EmailVerificationOperations.deleteStale(toDbDateTime(now));
  await EmailVerificationOperations.create({
    email: normalized,
    codeHash: hashCode(code),
    purpose,
    userId,
    expiresAt,
  });

  await sendSmtpEmail(
    normalized,
    'DNSMgr Email Verification Code',
    `Your verification code is: ${code}\n\nThis code expires in 10 minutes.`,
  );
  log.info('Verification code sent', { purpose });
}

export async function verifyEmailVerificationCode(
  userId: number | null,
  email: string,
  code: string,
  purpose: VerificationPurpose = 'profile',
): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  const row = await EmailVerificationOperations.findActive(normalized, purpose, toDbDateTime(new Date())) as
    | { id?: number; code_hash?: string; attempts?: number }
    | undefined;
  if (!row) return false;

  // 尝试次数上限：超过后即使码正确也拒绝（防 6 位码爆破）
  if (Number(row.attempts ?? 0) >= MAX_ATTEMPTS) {
    log.warn('Verification code attempts exceeded', { purpose });
    return false;
  }

  if (String(row.code_hash ?? '') !== hashCode(code.trim())) {
    await EmailVerificationOperations.incrementAttempts(Number(row.id));
    return false;
  }

  await EmailVerificationOperations.markUsed(Number(row.id));
  return true;
}