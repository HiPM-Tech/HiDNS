import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import crypto from 'crypto';
import { TOTPOperations, getDbType } from '../db/bal/business-adapter';

/**
 * TOTP (Time-based One-Time Password) 2FA 服务
 */

export interface TOTPSetup {
  secret: string;
  qrCode: string;
  backupCodes: string[];
}

export interface TOTPStatus {
  enabled: boolean;
  backupCodesRemaining: number;
}

/**
 * 生成 TOTP 密钥和二维码
 */
export async function generateTOTPSecret(userId: number, email: string): Promise<TOTPSetup> {
  const secret = authenticator.generateSecret();

  // 生成二维码
  const otpauth_url = authenticator.keyuri(email, 'DNSMgr', secret);
  const qrCode = await QRCode.toDataURL(otpauth_url);

  // 生成 10 个备用恢复码
  const backupCodes = generateBackupCodes(10);

  return {
    secret,
    qrCode,
    backupCodes,
  };
}

/**
 * 验证 TOTP 令牌
 */
export function verifyTOTPToken(secret: string, token: string): boolean {
  try {
    return authenticator.check(token, secret);
  } catch {
    return false;
  }
}

/**
 * 使用用户已存储的密钥校验 TOTP 令牌。
 * 用于关闭 2FA 等敏感操作前的二次确认——调用方不得自行传入 secret。
 */
export async function verifyTOTPTokenForUser(userId: number, token: unknown): Promise<boolean> {
  if (!token || typeof token !== 'string') return false;
  const result = await TOTPOperations.getByUser(userId);
  if (!result) return false;
  if (!(result as { enabled: number | boolean }).enabled) return false;
  const secret = (result as { secret?: string }).secret;
  if (!secret) return false;
  return verifyTOTPToken(secret, token);
}

/**
 * 启用 TOTP 2FA
 */
export async function enableTOTP(userId: number, secret: string, backupCodes: string[]): Promise<void> {
  // 加密备用码
  const encryptedCodes = backupCodes.map(code => encryptBackupCode(code));

  const dbType = getDbType();
  if (dbType === 'sqlite') {
    await TOTPOperations.enableSQLite(userId, secret, JSON.stringify(encryptedCodes));
  } else if (dbType === 'mysql') {
    await TOTPOperations.enableMySQL(userId, secret, JSON.stringify(encryptedCodes));
  } else {
    await TOTPOperations.enablePostgreSQL(userId, secret, JSON.stringify(encryptedCodes));
  }
}

/**
 * 禁用 TOTP 2FA
 */
export async function disableTOTP(userId: number): Promise<void> {
  const enabledValue = getDbType() === 'sqlite' ? 0 : false;
  await TOTPOperations.disable(userId, enabledValue);
}

/**
 * 获取 TOTP 状态
 */
export async function getTOTPStatus(userId: number): Promise<TOTPStatus> {
  const result = await TOTPOperations.getByUser(userId);

  if (!result) {
    return { enabled: false, backupCodesRemaining: 0 };
  }

  const backupCodes = JSON.parse((result as { backup_codes: string }).backup_codes || '[]');
  return {
    enabled: !!(result as { enabled: number | boolean }).enabled,
    backupCodesRemaining: backupCodes.length,
  };
}

/**
 * 使用备用码验证
 */
export async function verifyBackupCode(userId: number, code: string): Promise<boolean> {
  const enabledValue = getDbType() === 'sqlite' ? 1 : true;
  const result = await TOTPOperations.verifyBackupCode(userId, enabledValue);

  if (!result) return false;

  const backupCodes = JSON.parse((result as { backup_codes: string }).backup_codes || '[]');
  const encryptedCode = encryptBackupCode(code);

  const index = backupCodes.indexOf(encryptedCode);
  if (index === -1) return false;

  // 移除已使用的备用码
  backupCodes.splice(index, 1);
  await TOTPOperations.updateBackupCodes(userId, JSON.stringify(backupCodes));

  return true;
}

/**
 * 生成备用恢复码
 */
function generateBackupCodes(count: number): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
  }
  return codes;
}

/**
 * 加密备用码（简单的 base64 编码，生产环境应使用更强的加密）
 */
function encryptBackupCode(code: string): string {
  return Buffer.from(code).toString('base64');
}

/**
 * 解密备用码
 */
export function decryptBackupCode(encrypted: string): string {
  return Buffer.from(encrypted, 'base64').toString('utf-8');
}
