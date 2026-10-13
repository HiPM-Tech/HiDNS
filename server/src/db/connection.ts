// Re-export from dal/connection.ts - 新数据库连接系统
export {
  connect,
  disconnect,
  getConnection,
  transaction,
  getConnectionManager,
  ConnectionManager,
} from './dal/connection';

// Re-export types
export type {
  DatabaseConnection as DbConnection,
  DatabaseType as DbType,
  Transaction,
} from './dal/types';

// Re-export from config.ts for types
export {
  getDatabaseConfig,
  type DatabaseConfig,
} from './dal/config';

// Re-export DatabaseType from types
export type { DatabaseType } from './dal/types';

// 向后兼容的辅助函数
import { getConnection, connect as coreConnect, disconnect as coreDisconnect } from './dal/connection';

/**
 * 获取当前连接（向后兼容）
 * @deprecated 使用 getConnection() 替代
 */
export function getCurrentConnection() {
  try {
    return getConnection();
  } catch {
    return null;
  }
}

/**
 * 创建连接（向后兼容）
 * @deprecated 使用 connect() 替代
 */
export async function createConnection() {
  return coreConnect();
}

/**
 * 关闭连接（向后兼容）
 * @deprecated 使用 disconnect() 替代
 */
export async function closeConnection() {
  return coreDisconnect();
}

/**
 * 检查数据库是否已初始化（users 表是否存在）。
 *
 * 连接不可用或查询失败时**抛出异常**，不再静默返回 false。
 * 静默返回 false 会让“数据库故障”被误判为“系统未初始化”，
 * 进而错误地开放初始化入口（未授权接管风险）。
 */
export async function isDbInitialized(): Promise<boolean> {
  const conn = getConnection();
  const type = conn.type;

  if (type === 'sqlite') {
    const result = await conn.get("SELECT name FROM sqlite_master WHERE type='table' AND name='users'");
    return !!result;
  } else if (type === 'mysql') {
    const result = await conn.get("SELECT TABLE_NAME as name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'");
    return !!result;
  } else if (type === 'postgresql') {
    const result = await conn.get("SELECT tablename as name FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users'");
    return !!result;
  }
  return false;
}

/**
 * 检查是否有用户。
 *
 * 与 isDbInitialized 同理：失败时抛出异常，不静默返回 false。
 */
export async function hasUsers(): Promise<boolean> {
  const conn = getConnection();
  const result = await conn.get('SELECT COUNT(*) as cnt FROM users');
  return Number((result as { cnt: number | string })?.cnt ?? 0) > 0;
}

/** 数据库初始化状态三态 */
export type DbInitializationState = 'initialized' | 'uninitialized' | 'unreachable';

/**
 * 三态探测：严格区分“未初始化”与“数据库不可达”。
 *
 * - `initialized`：users 表存在且已有用户
 * - `uninitialized`：数据库可达，但尚未完成初始化
 * - `unreachable`：连接或查询失败——这是故障，**不是**未初始化
 */
export async function probeDbInitialization(): Promise<DbInitializationState> {
  try {
    if (!await isDbInitialized()) return 'uninitialized';
    return await hasUsers() ? 'initialized' : 'uninitialized';
  } catch {
    return 'unreachable';
  }
}
