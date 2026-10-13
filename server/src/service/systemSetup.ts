/**
 * 系统初始化配置服务。
 *
 * 路由层禁止直接操作数据库（§服务层 376、§数据库 2），
 * 因此数据库连接的重新配置、schema 初始化等操作全部收敛到本服务，
 * 由 routes/init.ts 调用。
 */

import { connect, disconnect } from '../db/dal/connection';
import type { DatabaseConfig } from '../db/dal/config';
import { resolveDefaultDbPath } from '../db/dal/config';
import { initializeDSM } from '../db/dsm/init-dsm';
import { saveEnvConfig } from '../config/env';
import { isDbInitialized, probeDbInitialization, type DbInitializationState } from '../db/connection';
import { createLogger } from '../lib/logger';

const log = createLogger('Service').sub('SystemSetup');

export type SetupDbType = 'sqlite' | 'mysql' | 'postgresql';

export interface SqliteSetupConfig {
  path?: string;
}

export interface ServerDbSetupConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
}

/** 对外（未鉴权初始化表单）暴露的数据库配置，已脱敏：不含 host / 账号 / 密码 */
export type PublicInitDbConfig = {
  type: SetupDbType;
  sqlite?: { path: string };
  mysql?: { ssl: boolean; database: string };
  postgresql?: { ssl: boolean; database: string };
};

/**
 * 构建数据库配置对象
 */
export function buildDbConfig(
  type: SetupDbType,
  sqlite?: SqliteSetupConfig,
  mysqlConfig?: ServerDbSetupConfig,
  pgConfig?: ServerDbSetupConfig
): DatabaseConfig {
  const dbConfig: DatabaseConfig = {
    type,
    logging: process.env.DB_LOGGING !== 'false',
    slowQueryThreshold: parseInt(process.env.DB_SLOW_QUERY_THRESHOLD || '100', 10),
  };

  if (type === 'sqlite') {
    let dbPath = sqlite?.path || resolveDefaultDbPath();
    dbPath = dbPath.replace(/\\/g, '/');
    dbConfig.sqlite = {
      path: dbPath,
      mode: 'readwrite',
      busyTimeout: 5000,
      enableWAL: true,
      foreignKeys: true,
    };
  } else if (type === 'mysql' && mysqlConfig) {
    dbConfig.mysql = {
      host: mysqlConfig.host,
      port: mysqlConfig.port || 3306,
      database: mysqlConfig.database,
      user: mysqlConfig.user,
      password: mysqlConfig.password,
      ssl: mysqlConfig.ssl,
      connectionLimit: 20,
      connectTimeout: 60000,
      acquireTimeout: 60000,
      timeout: 60000,
    };
  } else if (type === 'postgresql' && pgConfig) {
    dbConfig.postgresql = {
      host: pgConfig.host,
      port: pgConfig.port || 5432,
      database: pgConfig.database,
      user: pgConfig.user,
      password: pgConfig.password,
      ssl: pgConfig.ssl,
      poolSize: 20,
      connectionTimeoutMillis: 60000,
      idleTimeoutMillis: 30000,
    };
  }

  return dbConfig;
}

/**
 * 保存数据库配置到环境变量
 */
export function saveDatabaseConfig(
  type: SetupDbType,
  sqlite?: SqliteSetupConfig,
  mysqlConfig?: ServerDbSetupConfig,
  pgConfig?: ServerDbSetupConfig
): void {
  const envConfig: Record<string, string> = {
    DB_TYPE: type,
  };

  if (type === 'sqlite') {
    let dbPath = sqlite?.path || resolveDefaultDbPath();
    dbPath = dbPath.replace(/\\/g, '/');
    envConfig.DB_PATH = dbPath;
  } else if (type === 'mysql' && mysqlConfig) {
    envConfig.DB_HOST = mysqlConfig.host;
    envConfig.DB_PORT = String(mysqlConfig.port || 3306);
    envConfig.DB_NAME = mysqlConfig.database;
    envConfig.DB_USER = mysqlConfig.user;
    envConfig.DB_PASSWORD = mysqlConfig.password;
    envConfig.DB_SSL = mysqlConfig.ssl ? 'true' : 'false';
  } else if (type === 'postgresql' && pgConfig) {
    envConfig.DB_HOST = pgConfig.host;
    envConfig.DB_PORT = String(pgConfig.port || 5432);
    envConfig.DB_NAME = pgConfig.database;
    envConfig.DB_USER = pgConfig.user;
    envConfig.DB_PASSWORD = pgConfig.password;
    envConfig.DB_SSL = pgConfig.ssl ? 'true' : 'false';
  }

  saveEnvConfig(envConfig);
  log.info('Database configuration saved', { type });
}

/**
 * 以显式配置重建数据库连接（先断开旧连接）
 */
export async function applyDatabaseConfig(config: DatabaseConfig): Promise<void> {
  try {
    await disconnect();
  } catch {
    // 旧连接可能已失效，忽略断开异常
  }
  await connect(config);
}

/** 初始化 / 重置数据库 schema */
export async function initializeSchema(): Promise<void> {
  await initializeDSM();
}

/** 默认 SQLite 数据库路径（避免路由层直接依赖数据库配置模块） */
export function getDefaultSqlitePath(): string {
  return resolveDefaultDbPath();
}

/**
 * 读取对外暴露的数据库配置（已脱敏）。
 * 仅返回类型、SSL 与库名，**不含 host、账号与密码**。
 */
export function getPublicInitDbConfig(): PublicInitDbConfig {
  const type = process.env.DB_TYPE;
  const dbType: SetupDbType = type === 'mysql' || type === 'postgresql' ? type : 'sqlite';
  const ssl = process.env.DB_SSL === 'true';

  const result: PublicInitDbConfig = { type: dbType };

  if (dbType === 'sqlite') {
    result.sqlite = { path: resolveDefaultDbPath() };
  } else if (dbType === 'mysql') {
    result.mysql = { ssl, database: process.env.DB_NAME || 'HiDNS' };
  } else if (dbType === 'postgresql') {
    result.postgresql = { ssl, database: process.env.DB_NAME || 'HiDNS' };
  }

  return result;
}

/** 三态探测数据库初始化状态（区分「未初始化」与「不可达」） */
export async function getDbInitializationState(): Promise<DbInitializationState> {
  return probeDbInitialization();
}

/**
 * users 表是否已建立。
 * 用于区分「schema 尚未初始化」与「已有 schema 但还没有用户」两种未初始化子情形；
 * 连接失败时返回 false（调用方在此之前已排除 unreachable）。
 */
export async function isSchemaInitialized(): Promise<boolean> {
  try {
    return await isDbInitialized();
  } catch {
    return false;
  }
}
