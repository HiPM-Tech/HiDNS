import crypto from 'crypto';
import { SessionOperations, getDbType } from '../db/bal/business-adapter';

/**
 * 用户会话管理服务
 */

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

export interface Session {
  id: string;
  userId: number;
  token: string;
  ipAddress: string;
  userAgent: string;
  createdAt: string;
  lastActivityAt: string;
  expiresAt: string;
}

/**
 * 创建会话记录
 */
export async function createSession(
  userId: number,
  token: string,
  ipAddress: string,
  userAgent: string,
  expiresAt: string
): Promise<string> {
  const sessionId = generateSessionId();
  await SessionOperations.create(sessionId, userId, token, ipAddress, userAgent, expiresAt);
  return sessionId;
}

/**
 * 获取用户的所有活跃会话
 */
export async function getActiveSessions(userId: number): Promise<Session[]> {
  const nowTime = formatDateForDB(new Date());
  const sessions = await SessionOperations.getActiveByUser(userId, nowTime);
  return sessions as unknown as Session[];
}

/**
 * 更新会话最后活动时间
 */
export async function updateSessionActivity(sessionId: string): Promise<void> {
  await SessionOperations.updateActivity(sessionId);
}

/**
 * 删除会话（登出）
 */
export async function deleteSession(sessionId: string): Promise<void> {
  await SessionOperations.delete(sessionId);
}

/**
 * 删除用户的所有其他会话（远程登出）
 */
export async function deleteOtherSessions(userId: number, currentSessionId: string): Promise<void> {
  await SessionOperations.deleteOthers(userId, currentSessionId);
}

/**
 * 删除用户的所有会话
 */
export async function deleteAllSessions(userId: number): Promise<void> {
  await SessionOperations.deleteByUser(userId);
}

/**
 * 清理过期会话
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const nowTime = formatDateForDB(new Date());
  await SessionOperations.cleanupExpired(nowTime);
  return 0;
}

/**
 * 生成会话 ID
 */
function generateSessionId(): string {
  return `sess_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * 获取会话信息（通过 token）
 */
export async function getSessionByToken(token: string): Promise<Session | null> {
  const nowTime = formatDateForDB(new Date());
  const session = await SessionOperations.getByToken(token, nowTime);
  return (session as unknown as Session) || null;
}
