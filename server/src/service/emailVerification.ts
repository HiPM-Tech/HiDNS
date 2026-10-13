import crypto from 'crypto';
import { sendSmtpEmail } from './smtp';

type VerificationEntry = {
  code: string;
  expiresAt: number;
};

const store = new Map<string, VerificationEntry>();
const TTL_MS = 10 * 60 * 1000;

function keyOf(userId: number, email: string): string {
  return `${userId}:${email.trim().toLowerCase()}`;
}

function randomCode(): string {
  return String(crypto.randomInt(100000, 1000000));
}

export async function sendEmailVerificationCode(userId: number, email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const code = randomCode();
  store.set(keyOf(userId, normalized), { code, expiresAt: Date.now() + TTL_MS });
  await sendSmtpEmail(
    normalized,
    'DNSMgr Email Verification Code',
    `Your verification code is: ${code}\n\nThis code expires in 10 minutes.`
  );
}

export function verifyEmailVerificationCode(userId: number, email: string, code: string): boolean {
  const normalized = email.trim().toLowerCase();
  const key = keyOf(userId, normalized);
  const entry = store.get(key);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return false;
  }
  const ok = entry.code === code.trim();
  if (ok) store.delete(key);
  return ok;
}

