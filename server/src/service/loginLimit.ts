import { LoginLimitOperations, getDbType } from '../db/bal/business-adapter';
import { checkAuditRules } from './auditRules';
import { createLogger } from '../lib/logger';

const log = createLogger('Security').sub('LoginLimit');
/**
 * 将日期格式化为数据库兼容的格式 (YYYY-MM-DD HH:mm:ss)
 */
function formatDateForDB(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// Default configuration
const DEFAULT_CONFIG = {
  enabled: true,
  maxAttempts: 10,
  lockoutDuration: 60, // minutes
};

interface LoginLimitConfig {
  enabled: boolean;
  maxAttempts: number;
  lockoutDuration: number; // minutes
}

interface LoginAttempt {
  id: number;
  identifier: string;
  ip_address: string;
  attempt_count: number;
  last_attempt_at: string;
  locked_until: string | null;
}

// Get login limit configuration
export async function getLoginLimitConfig(): Promise<LoginLimitConfig> {
  try {
    const result = await LoginLimitOperations.getConfig();
    if (result) {
      return { ...DEFAULT_CONFIG, ...JSON.parse((result as { value: string }).value) };
    }
  } catch (e) {
    log.error('Failed to get config', { error: e });
  }
  return DEFAULT_CONFIG;
}

// Update login limit configuration
export async function updateLoginLimitConfig(config: Partial<LoginLimitConfig>): Promise<void> {
  const currentConfig = await getLoginLimitConfig();
  const newConfig = { ...currentConfig, ...config };
  await LoginLimitOperations.updateConfig(JSON.stringify(newConfig));
}

// Check if login is allowed for identifier (username or email)
/**
 * 锁定维度：账号 + 来源 IP。
 *
 * 只用账号做键时，任何人故意用错误密码试 5 次就能把别人的账号锁死（定向拒绝服务，
 * 第三轮实测可自锁 15 分钟）；加上 IP 后攻击者只能锁住自己。
 * 代价是分布式撞库需要多 IP，因此仍保留全局登录限流与密码复杂度要求。
 */
function attemptKey(identifier: string, ipAddress: string): string {
  const normalized = identifier.toLowerCase();
  return ipAddress ? `${normalized}|${ipAddress}` : normalized;
}

export async function checkLoginAllowed(identifier: string, ipAddress: string = ''): Promise<{ allowed: boolean; message?: string; remainingAttempts?: number }> {
  const config = await getLoginLimitConfig();

  if (!config.enabled) {
    return { allowed: true };
  }

  try {
    // Check existing attempt record（键 = 账号|IP）
    const result = await LoginLimitOperations.getAttempt(attemptKey(identifier, ipAddress));

    const attempt = result as LoginAttempt | undefined;

    if (attempt && attempt.locked_until) {
      const lockedUntil = new Date(attempt.locked_until);
      const nowTime = new Date();

      if (lockedUntil > nowTime) {
        const minutesLeft = Math.ceil((lockedUntil.getTime() - nowTime.getTime()) / (1000 * 60));
        return {
          allowed: false,
          message: `Account locked. Please try again in ${minutesLeft} minute(s).`,
        };
      }
    }

    // Calculate remaining attempts
    const currentAttempts = attempt?.attempt_count || 0;
    const remainingAttempts = Math.max(0, config.maxAttempts - currentAttempts);

    return {
      allowed: true,
      remainingAttempts,
    };
  } catch (e) {
    log.error('Failed to check login allowed', { error: e });
    return { allowed: true };
  }
}

// Record failed login attempt
export async function recordFailedAttempt(identifier: string, ipAddress: string = ''): Promise<{ locked: boolean; message?: string }> {
  const config = await getLoginLimitConfig();

  if (!config.enabled) {
    return { locked: false };
  }

  try {
    const normalizedIdentifier = identifier.toLowerCase();
    const key = attemptKey(identifier, ipAddress);

    // Get existing record（键 = 账号|IP，避免定向锁死他人账号）
    const result = await LoginLimitOperations.getAttempt(key);

    const attempt = result as LoginAttempt | undefined;
    const nowTime = new Date();

    if (attempt) {
      // Check if already locked
      if (attempt.locked_until) {
        const lockedUntil = new Date(attempt.locked_until);
        if (lockedUntil > nowTime) {
          const minutesLeft = Math.ceil((lockedUntil.getTime() - nowTime.getTime()) / (1000 * 60));
          return {
            locked: true,
            message: `Account locked. Please try again in ${minutesLeft} minute(s).`,
          };
        }
      }

      // Increment attempt count
      const newCount = attempt.attempt_count + 1;

      // Check if should lock
      if (newCount >= config.maxAttempts) {
        const lockoutMinutes = config.lockoutDuration;
        const lockedUntil = new Date(nowTime.getTime() + lockoutMinutes * 60 * 1000);

        await LoginLimitOperations.updateAttempt(attempt.id, newCount, formatDateForDB(lockedUntil));

        checkAuditRules(0, 'login_failed', '', { identifier: normalizedIdentifier, ip: ipAddress, attemptCount: newCount }).catch(e => log.error('Audit rule check failed', { error: e }));

        return {
          locked: true,
          message: `Too many failed attempts. Account locked for ${lockoutMinutes} minute(s).`,
        };
      }

      // Update attempt count
      await LoginLimitOperations.updateAttempt(attempt.id, newCount, null);

      checkAuditRules(0, 'login_failed', '', { identifier: normalizedIdentifier, ip: ipAddress, attemptCount: newCount }).catch(e => log.error('Audit rule check failed', { error: e }));

      const remainingAttempts = config.maxAttempts - newCount;
      return {
        locked: false,
        message: remainingAttempts > 0 ? `${remainingAttempts} attempt(s) remaining.` : undefined,
      };
    } else {
      // Create new record：键必须与读取时一致（账号|IP），
      // 否则计数永远查不到、5 次后仍显示「9 attempt(s) remaining」且每次失败多插一行。
      await LoginLimitOperations.createAttempt(key, ipAddress);

      const remainingAttempts = config.maxAttempts - 1;
      return {
        locked: false,
        message: `${remainingAttempts} attempt(s) remaining.`,
      };
    }
  } catch (e) {
    log.error('Failed to record failed attempt', { error: e });
    return { locked: false };
  }
}

// Clear login attempts on successful login
export async function clearLoginAttempts(identifier: string, ipAddress: string = ''): Promise<void> {
  try {
    await LoginLimitOperations.clearAttempts(attemptKey(identifier, ipAddress));
  } catch (e) {
    log.error('Failed to clear attempts', { error: e });
  }
}

// Get login attempt statistics (for admin)
export async function getLoginAttemptStats(): Promise<{
  totalLocked: number;
  recentAttempts: number;
  topIdentifiers: { identifier: string; attempts: number }[];
}> {
  try {
    const dbType = getDbType();
    const nowExpr = dbType === 'sqlite' ? "datetime('now')" : dbType === 'mysql' ? 'NOW()' : 'NOW()';
    const yesterdayExpr = dbType === 'sqlite' ? "datetime('now', '-1 day')" : dbType === 'mysql' ? 'NOW() - INTERVAL 1 DAY' : "NOW() - INTERVAL '1 day'";

    // Get total locked accounts
    const totalLocked = await LoginLimitOperations.getLockedCount(nowExpr);

    // Get recent attempts (last 24 hours)
    const recentAttempts = await LoginLimitOperations.getRecentCount(yesterdayExpr);

    // Get top identifiers with failed attempts
    const topResult = await LoginLimitOperations.getTopIdentifiers();
    const topIdentifiers = (topResult as { identifier: string; attempts: number }[]) || [];

    return {
      totalLocked,
      recentAttempts,
      topIdentifiers,
    };
  } catch (e) {
    log.error('Failed to get stats', { error: e });
    return { totalLocked: 0, recentAttempts: 0, topIdentifiers: [] };
  }
}

// Manually unlock an account (for admin)
export async function unlockAccount(identifier: string): Promise<void> {
  await LoginLimitOperations.clearAttempts(identifier);
}
