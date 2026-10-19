/**
 * 数据库业务适配器层 (Database Business Adapter Layer)
 *
 * 架构层级：
 * 路由 → 业务适配器（本文件）→ 数据库抽象层 → 数据库驱动层 → 数据库
 *
 * 设计原则：
 * 1. 函数式API - 路由层通过简单函数调用使用数据库
 * 2. 单一职责 - 每个函数只处理一个业务操作
 * 3. 高扩展性 - 新增业务只需添加新函数
 * 4. 封装隔离 - 数据库变动不影响路由层
 * 5. 完整日志 - 所有操作都有详细日志
 */

import crypto from 'crypto';
import type { SQLCompiler } from '../dal/query/compiler';
import { getDefaultCompiler } from '../dal/query/compiler';
import { transaction, getConnection } from '../dal/connection';
import { createLogger } from '../../lib/logger';
import { DomainQueryBuilder, RenewableDomainQueryBuilder, AccountQueryBuilder, TeamQueryBuilder } from './query-builders';

const log = createLogger('BAL').sub('BusinessAdapter');

// 本地 db 对象，避免循环依赖
const db = {
  get type() { return process.env.DB_TYPE || 'sqlite'; },
  get isConnected() {
    try {
      const conn = getConnection();
      return !!conn;
    } catch {
      return false;
    }
  },
  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    const conn = getConnection();
    return conn.query<T>(sql, params);
  },
  async get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
    const conn = getConnection();
    return conn.get<T>(sql, params);
  },
  async execute(sql: string, params?: unknown[]): Promise<void> {
    const conn = getConnection();
    return conn.execute(sql, params);
  },
  async insert(sql: string, params?: unknown[]): Promise<number> {
    const conn = getConnection();
    return conn.insert(sql, params);
  },
  async run(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    const conn = getConnection();
    return conn.run(sql, params);
  },
};

// ============================================================================
// 类型定义
// ============================================================================

/** 查询结果类型 */
export type QueryResult = Record<string, unknown>;

/** 业务操作上下*/
interface OperationContext {
  operation: string;
  table?: string;
  userId?: number;
  requestId?: string;
}

// ============================================================================
// SQL 兼容性辅助函
// ============================================================================

/**
 * 生成 UPSERT SQL 语句（兼MySQL/PostgreSQL/SQLite
 * @param table 表名
 * @param columns 列名数组（不updated_at
 * @param values 值数
 * @param conflictKey 冲突
 * @param updateColumns 需要更新的列（不含 updated_at
 */
function buildUpsertSql(
  table: string,
  columns: string[],
  values: unknown[],
  conflictKey: string,
  updateColumns: string[]
): { sql: string; params: unknown[] } {
  const dbType = getDbType();

  // 添加 updated_at
  const allColumns = [...columns, 'updated_at'];

  if (dbType === 'mysql') {
    // MySQL: INSERT ... ON DUPLICATE KEY UPDATE
    // updated_at 不在 INSERT 的列中，只在 UPDATE 部分使用 NOW()
    const insertColumns = columns.map(col => col === 'key' || col === 'value' ? `\`${col}\`` : col).join(', ');
    const placeholders = columns.map(() => '?').join(', ');
    const updates = updateColumns.map(col => {
      const escaped = col === 'key' || col === 'value' ? `\`${col}\`` : col;
      return `${escaped} = VALUES(${escaped})`;
    }).join(', ');

    const sql = `INSERT INTO ${table} (${insertColumns}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}, updated_at = NOW()`;
    return { sql, params: values };
  } else if (dbType === 'postgresql') {
    // PostgreSQL: INSERT ... ON CONFLICT DO UPDATE
    // updated_at 不在 INSERT 的列中，只在 UPDATE 部分使用 NOW()
    const insertColumns = columns.join(', ');
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const updates = updateColumns.map(col => {
      return `${col} = EXCLUDED.${col}`;
    }).join(', ');

    const sql = `INSERT INTO ${table} (${insertColumns}) VALUES (${placeholders}) ON CONFLICT(${conflictKey}) DO UPDATE SET ${updates}, updated_at = NOW()`;
    return { sql, params: values };
  } else {
    // SQLite: INSERT ... ON CONFLICT DO UPDATE
    // updated_at 不在 INSERT 的列中，只在 UPDATE 部分使用 CURRENT_TIMESTAMP
    const insertColumns = columns.join(', ');
    const placeholders = columns.map(() => '?').join(', ');
    const updates = updateColumns.map(col => {
      return `${col} = excluded.${col}`;
    }).join(', ');

    const sql = `INSERT INTO ${table} (${insertColumns}) VALUES (${placeholders}) ON CONFLICT(${conflictKey}) DO UPDATE SET ${updates}, updated_at = CURRENT_TIMESTAMP`;
    return { sql, params: values };
  }
}

// ============================================================================
// 日志系统 - 使用统一日志模块
// ============================================================================

/** 创建操作日志上下*/
function createOperationLogger(context: OperationContext) {
  return {
    start: () => log.debug( `Starting ${context.operation}`, { table: context.table, userId: context.userId }),
    success: (duration: number, meta?: Record<string, unknown>) =>
      log.debug( `${context.operation} completed`, { ...meta, duration: `${duration}ms`, table: context.table }),
    error: (error: unknown, duration: number) =>
      log.error( `${context.operation} failed`, { error, duration: `${duration}ms`, table: context.table }),
  };
}

// ============================================================================
// 底层数据库操作（内部使用
// ============================================================================

/** SQL处理*/
function processSql(sql: string, dbType: string): string {
  const originalSql = sql;

  // MySQL 兼容性处
  if (dbType === 'mysql') {
    // 1. 先处ON CONFLICT 转换（在关键字转义之前）
    // 匹配: ON CONFLICT(...) DO UPDATE SET col = excluded.col, ...
    sql = sql.replace(
      /ON\s+CONFLICT\s*\([^)]+\)\s*DO\s+UPDATE\s+SET\s+(.+?)(?:\s*$|\s+(?=RETURNING|WHERE|ORDER|LIMIT|OFFSET))/i,
      (match, updateClause) => {
        // 转换 excluded.col VALUES(col)
        const mysqlUpdateClause = updateClause.replace(
          /excluded\.([a-zA-Z_][a-zA-Z0-9_]*)/gi,
          'VALUES($1)'
        );
        return `ON DUPLICATE KEY UPDATE ${mysqlUpdateClause}`;
      }
    );

    // 2. 转义保留关键字（仅转义作为标识符的关键字
    // 注意：跳过已经转义的、在 ON DUPLICATE KEY UPDATE 中的、以SQL 关键字上下文中的
    const keywords = ['key', 'value'];
    keywords.forEach(keyword => {
      // 匹配未转义的关键字：前面不是反引号，后面也不是反引号
      // 使用 lookbehind lookahead 来确保关键字没有被反引号包围
      const regex = new RegExp(`(?<!\x60)\\b${keyword}\\b(?!\x60)`, 'gi');
      sql = sql.replace(regex, (match, offset) => {
        const upperSql = sql.toUpperCase();
        const beforeContext = sql.substring(Math.max(0, offset - 20), offset).toUpperCase();
        const afterContext = sql.substring(offset + match.length, Math.min(sql.length, offset + match.length + 20)).toUpperCase();

        // 跳过 ON DUPLICATE KEY UPDATE 中的 KEY
        if (beforeContext.includes('ON DUPLICATE') && keyword.toLowerCase() === 'key') {
          return match;
        }

        // 跳过 ORDER BY / GROUP BY 中的 BY
        if (beforeContext.includes('ORDER') || beforeContext.includes('GROUP')) {
          return match;
        }

        // 跳过 FOREIGN KEY / PRIMARY KEY 中的 KEY
        if (beforeContext.includes('FOREIGN') || beforeContext.includes('PRIMARY')) {
          return match;
        }

        return `\`${keyword}\``;
      });
    });
  }

  if (sql !== originalSql) {
    log.debug( 'SQL processed', { original: originalSql, processed: sql });
  }

  return sql;
}

/** 执行查询并返回多行（内部*/
async function queryInternal<T = QueryResult>(sql: string, params?: unknown[], context?: OperationContext): Promise<T[]> {
  const startTime = Date.now();
  const processedSql = processSql(sql, db.type);

  log.debug( 'Executing query', { sql: processedSql, params, operation: context?.operation });

  try {
    const results = await db.query<T>(processedSql, params);
    const duration = Date.now() - startTime;
    log.debug( `Query executed`, {
      sql: processedSql.substring(0, 100),
      rowCount: results.length,
      duration: `${duration}ms`,
      operation: context?.operation
    });
    return results;
  } catch (error) {
    const duration = Date.now() - startTime;
    log.error( 'Query failed', {
      sql: processedSql,
      params,
      error,
      duration: `${duration}ms`,
      operation: context?.operation
    });
    throw error;
  }
}

/** 将参数中的 boolean 值转为 0/1（兼容 PostgreSQL 严格类型要求） */
function normalizeParams(params?: unknown[]): unknown[] | undefined {
  if (!params) return params;
  return params.map(p => typeof p === 'boolean' ? (p ? 1 : 0) : p);
}

/** 执行查询并返回单行（内部*/
async function getInternal<T = QueryResult>(sql: string, params?: unknown[], context?: OperationContext): Promise<T | undefined> {
  const startTime = Date.now();
  const processedSql = processSql(sql, db.type);

  log.debug( 'Executing get', { sql: processedSql, params, operation: context?.operation });

  try {
    const result = await db.get<T>(processedSql, normalizeParams(params));
    const duration = Date.now() - startTime;
    log.debug( `Get executed`, {
      sql: processedSql.substring(0, 100),
      found: result !== undefined,
      duration: `${duration}ms`,
      operation: context?.operation
    });
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    log.error( 'Get failed', {
      sql: processedSql,
      params,
      error,
      duration: `${duration}ms`,
      operation: context?.operation
    });
    throw error;
  }
}

/** 执行INSERT/UPDATE/DELETE（内部） */
async function executeInternal(sql: string, params?: unknown[], context?: OperationContext): Promise<void> {
  const startTime = Date.now();
  const processedSql = processSql(sql, db.type);

  log.debug( 'Executing command', { sql: processedSql, params, operation: context?.operation });

  try {
    await db.execute(processedSql, normalizeParams(params));
    const duration = Date.now() - startTime;
    log.debug( `Command executed`, {
      operation: context?.operation,
      duration: `${duration}ms`
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    log.error( 'Command failed', {
      sql: processedSql,
      params,
      error,
      duration: `${duration}ms`,
      operation: context?.operation
    });
    throw error;
  }
}

/** 执行INSERT并返回ID（内部） */
async function insertInternal(sql: string, params?: unknown[], context?: OperationContext): Promise<number> {
  const startTime = Date.now();
  const processedSql = processSql(sql, db.type);

  log.debug( 'Executing insert', { sql: processedSql, params, operation: context?.operation });

  try {
    const id = await db.insert(processedSql, normalizeParams(params));
    const duration = Date.now() - startTime;
    log.debug( `Insert executed`, {
      operation: context?.operation,
      insertId: id,
      duration: `${duration}ms`
    });
    return id;
  } catch (error) {
    const duration = Date.now() - startTime;
    log.error( 'Insert failed', {
      sql: processedSql,
      params,
      error,
      duration: `${duration}ms`,
      operation: context?.operation
    });
    throw error;
  }
}

/** 执行UPDATE/DELETE并返回影响行数（内部*/
async function runInternal(sql: string, params?: unknown[], context?: OperationContext): Promise<{ changes: number }> {
  const startTime = Date.now();
  const processedSql = processSql(sql, db.type);

  log.debug( 'Executing run', { sql: processedSql, params, operation: context?.operation });

  try {
    const result = await db.run(processedSql, params);
    const duration = Date.now() - startTime;
    log.debug( `Run executed`, {
      operation: context?.operation,
      changes: result.changes,
      duration: `${duration}ms`
    });
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    log.error( 'Run failed', {
      sql: processedSql,
      params,
      error,
      duration: `${duration}ms`,
      operation: context?.operation
    });
    throw error;
  }
}

// ============================================================================
// 通用数据库操作（可直接使用）
// ============================================================================

/** 执行查询并返回多*/
export async function query<T = QueryResult>(sql: string, params?: unknown[]): Promise<T[]> {
  return queryInternal<T>(sql, params, { operation: 'query' });
}

/** 执行查询并返回单*/
export async function get<T = QueryResult>(sql: string, params?: unknown[]): Promise<T | undefined> {
  return getInternal<T>(sql, params, { operation: 'get' });
}

/** 执行INSERT/UPDATE/DELETE */
export async function execute(sql: string, params?: unknown[]): Promise<void> {
  return executeInternal(sql, params, { operation: 'execute' });
}

/** 执行INSERT并返回ID */
export async function insert(sql: string, params?: unknown[]): Promise<number> {
  return insertInternal(sql, params, { operation: 'insert' });
}

/** 执行UPDATE/DELETE并返回影响行*/
export async function run(sql: string, params?: unknown[]): Promise<{ changes: number }> {
  return runInternal(sql, params, { operation: 'run' });
}

/** 获取当前时间函数 */
export function now(): string {
  const compiler = getDefaultCompiler();
  return compiler.now();
}

/**
 * 将日期格式化为数据库兼容的格(YYYY-MM-DD HH:mm:ss)
 * 根据数据库类型自动转换格式：
 * - MySQL: YYYY-MM-DD HH:mm:ss
 * - SQLite: ISO 8601 格式
 * - PostgreSQL: ISO 8601 格式
 */
export function formatDateForDB(date: Date): string {
  const dbType = getDbType();
  if (dbType === 'mysql') {
    // MySQL 需YYYY-MM-DD HH:mm:ss 格式
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }
  // SQLite PostgreSQL 支持 ISO 8601
  return date.toISOString();
}

/** 获取数据库类*/
export function getDbType(): string {
  return db.type;
}

/** 检查数据库是否已连*/
export function isDbConnected(): boolean {
  return db.isConnected;
}

/**
 * 获取数据库驱动层统计信息
 * @returns 查询数、错误数、IO 读/写次数（IO 仅在 SQLite 下有效）
 */
export function getDatabaseStats(): { queries: number; errors: number; reads: number; writes: number } {
  try {
    const conn = getConnection();
    const stats = conn.getStats();
    const io = conn.getIoStats();
    return { queries: stats.queries, errors: stats.errors, reads: io.reads, writes: io.writes };
  } catch {
    return { queries: 0, errors: 0, reads: 0, writes: 0 };
  }
}

// ============================================================================
// 用户相关业务操作
// ============================================================================

export const UserOperations = {
  /** 根据ID获取用户完整信息 */
  async getById(id: number): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT id, username, nickname, email, password_hash, role_level as role, role_level, role as role_name, status, created_at, updated_at FROM users WHERE id = ?',
      [id],
      { operation: 'User.getById', table: 'users' }
    );
  },

  /** 根据用户名获取用户完整信*/
  async getByUsername(username: string): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT id, username, nickname, email, password_hash, role_level as role, role_level, role as role_name, status, created_at, updated_at FROM users WHERE username = ?',
      [username],
      { operation: 'User.getByUsername', table: 'users' }
    );
  },

  /** 根据邮箱获取用户完整信息 */
  async getByEmail(email: string): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT id, username, nickname, email, password_hash, role_level as role, role_level, role as role_name, status, created_at, updated_at FROM users WHERE email = ?',
      [email],
      { operation: 'User.getByEmail', table: 'users' }
    );
  },

  /** 根据ID获取用户公开信息（不含密码） */
  async getPublicById(id: number): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT id, username, nickname, email, role_level as role, role_level, role as role_name, status, created_at, updated_at FROM users WHERE id = ?',
      [id],
      { operation: 'User.getPublicById', table: 'users' }
    );
  },

  /** 获取所有用*/
  async getAll(): Promise<QueryResult[]> {
    return queryInternal(
      'SELECT id, username, nickname, email, role_level as role, role_level, role as role_name, status, created_at, updated_at FROM users ORDER BY id',
      [],
      { operation: 'User.getAll', table: 'users' }
    );
  },

  /** 创建用户 */
  async create(data: { username: string; nickname: string; email: string; password_hash: string; role: string; role_level: number }): Promise<number> {
    return insertInternal(
      'INSERT INTO users (username, nickname, email, password_hash, role, role_level) VALUES (?, ?, ?, ?, ?, ?)',
      [data.username, data.nickname, data.email, data.password_hash, data.role, data.role_level],
      { operation: 'User.create', table: 'users' }
    );
  },

  /** 更新用户 */
  async update(id: number, updates: Record<string, unknown>): Promise<void> {
    const fields = Object.keys(updates);
    if (fields.length === 0) return;

    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = Object.values(updates);

    return executeInternal(
      `UPDATE users SET ${setClause} WHERE id = ?`,
      [...values, id],
      { operation: 'User.update', table: 'users' }
    );
  },

  /** 删除用户 */
  async delete(id: number): Promise<void> {
    return executeInternal('DELETE FROM users WHERE id = ?', [id], { operation: 'User.delete', table: 'users' });
  },

  /** 更新密码 */
  async updatePassword(id: number, passwordHash: string): Promise<void> {
    return executeInternal(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [passwordHash, id],
      { operation: 'User.updatePassword', table: 'users' }
    );
  },

  /** 获取用户数量 */
  async getCount(): Promise<number> {
    const result = await getInternal<{ cnt: number }>('SELECT COUNT(*) as cnt FROM users', [], { operation: 'User.getCount', table: 'users' });
    return result?.cnt || 0;
  },
};

// ============================================================================
// DNS账号业务操作
// ============================================================================

export const DnsAccountOperations = {
  /** 根据ID获取账号 */
  async getById(id: number): Promise<QueryResult | undefined> {
    return getInternal('SELECT * FROM dns_accounts WHERE id = ?', [id], { operation: 'DnsAccount.getById', table: 'dns_accounts' });
  },

  /** 获取所有账*/
  async getAll(): Promise<QueryResult[]> {
    return queryInternal('SELECT * FROM dns_accounts ORDER BY id', [], { operation: 'DnsAccount.getAll', table: 'dns_accounts' });
  },

  /** 获取用户可访问的账号 */
  async getByUserId(userId: number): Promise<QueryResult[]> {
    return queryInternal(
      'SELECT * FROM dns_accounts WHERE created_by = ? ORDER BY id',
      [userId],
      { operation: 'DnsAccount.getByUserId', table: 'dns_accounts' }
    );
  },

  /** 获取用户可访问的账号（包括团队共享） */
  async getAccessibleByUserId(userId: number, teamIds: number[]): Promise<QueryResult[]> {
    if (teamIds.length > 0) {
      const placeholders = teamIds.map(() => '?').join(',');
      return queryInternal(
        `SELECT * FROM dns_accounts WHERE created_by = ? OR team_id IN (${placeholders}) ORDER BY id`,
        [userId, ...teamIds],
        { operation: 'DnsAccount.getAccessibleByUserId', table: 'dns_accounts' }
      );
    }
    return this.getByUserId(userId);
  },

  /** 创建账号 */
  async create(data: { type: string; name: string; config: string; remark: string; created_by: number; team_id?: number | null }): Promise<number> {
    return insertInternal(
      'INSERT INTO dns_accounts (type, name, config, remark, created_by, team_id) VALUES (?, ?, ?, ?, ?, ?)',
      [data.type, data.name, data.config, data.remark, data.created_by, data.team_id ?? null],
      { operation: 'DnsAccount.create', table: 'dns_accounts' }
    );
  },

  /** 更新账号 */
  async update(id: number, updates: Record<string, unknown>): Promise<void> {
    const fields = Object.keys(updates);
    if (fields.length === 0) return;

    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = Object.values(updates);

    return executeInternal(
      `UPDATE dns_accounts SET ${setClause} WHERE id = ?`,
      [...values, id],
      { operation: 'DnsAccount.update', table: 'dns_accounts' }
    );
  },

  /** 删除账号 */
  async delete(id: number): Promise<void> {
    return executeInternal('DELETE FROM dns_accounts WHERE id = ?', [id], { operation: 'DnsAccount.delete', table: 'dns_accounts' });
  },

  /** 获取账号的创建*/
  async getCreatedBy(id: number): Promise<number | undefined> {
    const result = await getInternal<{ created_by: number }>(
      'SELECT created_by FROM dns_accounts WHERE id = ?',
      [id],
      { operation: 'DnsAccount.getCreatedBy', table: 'dns_accounts' }
    );
    return result?.created_by;
  },

  /** 根据类型获取账号 */
  async getByType(type: string): Promise<QueryResult[]> {
    return queryInternal(
      'SELECT * FROM dns_accounts WHERE type = ?',
      [type],
      { operation: 'DnsAccount.getByType', table: 'dns_accounts' }
    );
  },

  /** 根据类型和用户获取账*/
  async getByTypeAndUser(type: string, userId: number): Promise<QueryResult[]> {
    return queryInternal(
      'SELECT * FROM dns_accounts WHERE type = ? AND created_by = ?',
      [type, userId],
      { operation: 'DnsAccount.getByTypeAndUser', table: 'dns_accounts' }
    );
  },

  /** 根据类型、用户或团队获取账号 */
  async getByTypeAndUserOrTeams(type: string, userId: number, teamIds: number[]): Promise<QueryResult[]> {
    const placeholders = teamIds.map(() => '?').join(',');
    return queryInternal(
      `SELECT * FROM dns_accounts WHERE type = ? AND (created_by = ? OR team_id IN (${placeholders}))`,
      [type, userId, ...teamIds],
      { operation: 'DnsAccount.getByTypeAndUserOrTeams', table: 'dns_accounts' }
    );
  },

  /** 更新账号启用状*/
  async updateEnabled(id: number, enabled: boolean): Promise<void> {
    await executeInternal(
      'UPDATE dns_accounts SET enabled = ? WHERE id = ?',
      [enabled ? 1 : 0, id],
      { operation: 'DnsAccount.updateEnabled', table: 'dns_accounts' }
    );
  },
};

// ============================================================================
// 域名业务操作
// ============================================================================

export const DomainOperations = {
  /** 根据ID获取域名 */
  async getById(id: number): Promise<QueryResult | undefined> {
    return getInternal('SELECT * FROM domains WHERE id = ?', [id], { operation: 'Domain.getById', table: 'domains' });
  },

  /** 根据名称获取域名 */
  async getByName(name: string): Promise<QueryResult | undefined> {
    return getInternal('SELECT * FROM domains WHERE name = ?', [name], { operation: 'Domain.getByName', table: 'domains' });
  },

  /** 根据名称和账号ID获取域名 */
  async getByAccountIdAndName(accountId: number, name: string): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT * FROM domains WHERE account_id = ? AND name = ?',
      [accountId, name],
      { operation: 'Domain.getByAccountIdAndName', table: 'domains' }
    );
  },

  /** 获取所有域*/
  async getAll(): Promise<QueryResult[]> {
    return queryInternal('SELECT * FROM domains ORDER BY id', [], { operation: 'Domain.getAll', table: 'domains' });
  },

  /** 获取账号下的域名 */
  async getByAccountId(accountId: number): Promise<QueryResult[]> {
    return queryInternal(
      'SELECT * FROM domains WHERE account_id = ? ORDER BY id',
      [accountId],
      { operation: 'Domain.getByAccountId', table: 'domains' }
    );
  },

  /** 根据ID列表获取域名（用于Token认证优化*/
  async getByIds(ids: number[], options?: { accountId?: number; keyword?: string; domainMatch?: string }): Promise<QueryResult[]> {
    if (ids.length === 0) return [];

    const builder = DomainQueryBuilder.forTokenAuth(ids, options);
    const { sql, params } = builder.build();

    return queryInternal(sql, params, { operation: 'Domain.getByIds', table: 'domains' });
  },

  /** 获取所有域名（用于超级管理员Token认证*/
  async getAllForSuperAdmin(options?: { accountId?: number; keyword?: string; domainMatch?: string }): Promise<QueryResult[]> {
    const builder = DomainQueryBuilder.forSuperAdmin(options);
    const { sql, params } = builder.build();

    return queryInternal(sql, params, { operation: 'Domain.getAllForSuperAdmin', table: 'domains' });
  },

  /** 获取所有域名（带分页和过滤，用于高性能场景*/
  async getAllForSuperAdminWithPagination(options: {
    accountId?: number;
    keyword?: string;
    domainMatch?: string;
    domainStatus?: 'enabled' | 'disabled' | 'all';
    domainType?: 'apex' | 'subdomain';
    pinnedDomainIds?: number[];  // 新增：置顶域ID 列表
    page: number;
    pageSize: number;
  }): Promise<{ list: QueryResult[]; total: number }> {
    const {
      accountId,
      keyword,
      domainMatch,
      domainStatus = 'all',
      domainType,
      pinnedDomainIds = [],
      page,
      pageSize,
    } = options;

    // 构建查询
    let builder = DomainQueryBuilder.forSuperAdmin({ accountId, keyword, domainMatch });

    // 添加 enabled 过滤
    if (domainStatus === 'enabled') {
      builder = builder.whereDomainEnabled(true);
    } else if (domainStatus === 'disabled') {
      builder = builder.whereDomainEnabled(false);
    }
    // domainStatus === 'all' 时不过滤

    // 添加 domain_type 过滤
    if (domainType) {
      builder = builder.whereDomainType(domainType);
    }

    const { sql: baseSql, params: baseParams } = builder.build();

    // 如果有置顶域名，添加置顶排序
    let orderByClause = '';
    if (pinnedDomainIds.length > 0) {
      const dbType = process.env.DB_TYPE || 'sqlite';
      if (dbType === 'mysql') {
        // MySQL: 使用 FIELD() 函数
        const idsList = pinnedDomainIds.join(',');
        orderByClause = `FIELD(d.id, ${idsList}) DESC, d.id ASC`;
      } else if (dbType === 'postgresql') {
        // PostgreSQL: 使用 CASE WHEN
        const caseWhen = pinnedDomainIds.map((id, index) => `WHEN ${id} THEN ${index}`).join(' ');
        orderByClause = `(CASE d.id ${caseWhen} ELSE ${pinnedDomainIds.length} END) ASC, d.id ASC`;
      } else {
        // SQLite: 使用 CASE WHEN（与 PostgreSQL 相同
        const caseWhen = pinnedDomainIds.map((id, index) => `WHEN ${id} THEN ${index}`).join(' ');
        orderByClause = `(CASE d.id ${caseWhen} ELSE ${pinnedDomainIds.length} END) ASC, d.id ASC`;
      }
    } else {
      orderByClause = 'd.id ASC';
    }

    // 当使用 domain_match 时，按域名长度降序排列（最具体匹配优先）
    if (domainMatch && orderByClause) {
      orderByClause = orderByClause.replace('d.id ASC', 'LENGTH(d.name) DESC, d.id ASC');
    }

    // 查询总数
    const countSql = `SELECT COUNT(*) as count FROM (${baseSql}) as subquery`;
    const countResult = await queryInternal(countSql, baseParams, {
      operation: 'Domain.getAllForSuperAdminWithPagination.count',
      table: 'domains'
    });
    const total = Number((countResult[0] as any)?.count || 0);

    // 查询分页数据
    const offset = (page - 1) * pageSize;

    // 移除原有ORDER BY，添加置顶排
    const baseSqlWithoutOrderBy = baseSql.replace(/\s+ORDER\s+BY\s+[^)]+$/i, '');

    // MySQL 不支持在 prepared statement 中对 LIMIT/OFFSET 使用参数化占位符
    // 需要直接将整数值拼接到 SQL 中（已验证为整数，安全）
    const paginatedSql = `${baseSqlWithoutOrderBy} ORDER BY ${orderByClause} LIMIT ${parseInt(String(pageSize), 10)} OFFSET ${parseInt(String(offset), 10)}`;

    // Debug log
    log.info('SQL:', {
      page,
      pageSize,
      pinnedDomainIds: pinnedDomainIds.length,
      orderByClause,
      sql: paginatedSql.substring(0, 300)
    });

    const list = await queryInternal(paginatedSql, baseParams, {
      operation: 'Domain.getAllForSuperAdminWithPagination.list',
      table: 'domains'
    });

    return { list, total };
  },

  /** 创建域名 */
  async create(data: { account_id: number; name: string; third_id?: string; record_count?: number; remark?: string; adapter_data?: string | null }): Promise<number> {
    return insertInternal(
      'INSERT INTO domains (account_id, name, third_id, record_count, remark, adapter_data) VALUES (?, ?, ?, ?, ?, ?)',
      [data.account_id, data.name, data.third_id ?? null, data.record_count ?? 0, data.remark ?? '', data.adapter_data ?? null],
      { operation: 'Domain.create', table: 'domains' }
    );
  },

  /** 更新域名 */
  async update(id: number, updates: Record<string, unknown>): Promise<void> {
    const fields = Object.keys(updates);
    if (fields.length === 0) return;

    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = Object.values(updates);

    return executeInternal(
      `UPDATE domains SET ${setClause} WHERE id = ?`,
      [...values, id],
      { operation: 'Domain.update', table: 'domains' }
    );
  },

  /** 删除域名 */
  async delete(id: number): Promise<void> {
    return executeInternal('DELETE FROM domains WHERE id = ?', [id], { operation: 'Domain.delete', table: 'domains' });
  },

  /** 批量删除域名 */
  async batchDelete(ids: number[]): Promise<{ deleted: number; failed: number; errors: Array<{ id: number; error: string }> }> {
    const result = {
      deleted: 0,
      failed: 0,
      errors: [] as Array<{ id: number; error: string }>,
    };

    for (const id of ids) {
      try {
        await executeInternal('DELETE FROM domains WHERE id = ?', [id], { operation: 'Domain.batchDelete', table: 'domains' });
        result.deleted++;
      } catch (error) {
        result.failed++;
        result.errors.push({
          id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return result;
  },

  /** 更新记录数量 */
  async updateRecordCount(id: number, count: number): Promise<void> {
    return executeInternal(
      'UPDATE domains SET record_count = ? WHERE id = ?',
      [count, id],
      { operation: 'Domain.updateRecordCount', table: 'domains' }
    );
  },

  /** 更新域名的第三方ID和记录数 */
  async updateThirdIdAndRecordCount(id: number, thirdId: string, recordCount: number): Promise<void> {
    return executeInternal(
      'UPDATE domains SET third_id = ?, record_count = ? WHERE id = ?',
      [thirdId, recordCount, id],
      { operation: 'Domain.updateThirdIdAndRecordCount', table: 'domains' }
    );
  },

  /** 更新域名的备注和隐藏状*/
  async updateRemarkAndHidden(id: number, remark?: string, isHidden?: number): Promise<void> {
    const updates: string[] = [];
    const params: unknown[] = [];
    if (remark !== undefined) { updates.push('remark = ?'); params.push(remark); }
    if (isHidden !== undefined) { updates.push('is_hidden = ?'); params.push(isHidden); }
    if (updates.length === 0) return;
    params.push(id);
    return executeInternal(
      `UPDATE domains SET ${updates.join(', ')} WHERE id = ?`,
      params,
      { operation: 'Domain.updateRemarkAndHidden', table: 'domains' }
    );
  },

  /** 获取用户可访问的域名列表（带过滤*/
  async getAccessibleDomains(params: {
    userId: number;
    teamIds: number[];
    accountId?: number;
    keyword?: string;
    isSuper?: boolean;
  }): Promise<QueryResult[]> {
    const { userId, teamIds, accountId, keyword, isSuper } = params;

    let builder: DomainQueryBuilder;

    if (isSuper) {
      // Super admin: use simplified query
      builder = DomainQueryBuilder.accessibleForSuperAdmin({ accountId, keyword });
    } else {
      // Regular user: full permission check with teams
      builder = DomainQueryBuilder.accessibleForUser(userId, teamIds, { accountId, keyword });
    }

    const { sql, params: queryParams } = builder.build();

    return queryInternal(sql, queryParams, {
      operation: isSuper
        ? 'Domain.getAccessibleDomains.super'
        : 'Domain.getAccessibleDomains',
      table: 'domains'
    });
  },

  /** 获取用户可访问的域名列表（带分页和过滤，用于高性能场景*/
  async getAccessibleDomainsWithPagination(params: {
    userId: number;
    teamIds: number[];
    accountId?: number;
    keyword?: string;
    domainMatch?: string;
    domainStatus?: 'enabled' | 'disabled' | 'all';
    domainType?: 'apex' | 'subdomain';
    pinnedDomainIds?: number[];  // 新增：置顶域ID 列表
    page: number;
    pageSize: number;
  }): Promise<{ list: QueryResult[]; total: number }> {
    const {
      userId,
      teamIds,
      accountId,
      keyword,
      domainMatch,
      domainStatus = 'all',
      domainType,
      pinnedDomainIds = [],
      page,
      pageSize,
    } = params;

    // 构建查询
    let builder = DomainQueryBuilder.accessibleForUser(userId, teamIds, { accountId, keyword, domainMatch });

    // 添加 enabled 过滤
    if (domainStatus === 'enabled') {
      builder = builder.whereDomainEnabled(true);
    } else if (domainStatus === 'disabled') {
      builder = builder.whereDomainEnabled(false);
    }
    // domainStatus === 'all' 时不过滤

    // 添加 domain_type 过滤
    if (domainType) {
      builder = builder.whereDomainType(domainType);
    }

    const { sql: baseSql, params: baseParams } = builder.build();

    // 如果有置顶域名，添加置顶排序
    let orderByClause = '';
    if (pinnedDomainIds.length > 0) {
      const dbType = process.env.DB_TYPE || 'sqlite';
      if (dbType === 'mysql') {
        // MySQL: 使用 FIELD() 函数
        const idsList = pinnedDomainIds.join(',');
        orderByClause = `FIELD(d.id, ${idsList}) DESC, d.id ASC`;
      } else if (dbType === 'postgresql') {
        // PostgreSQL: 使用 CASE WHEN
        const caseWhen = pinnedDomainIds.map((id, index) => `WHEN ${id} THEN ${index}`).join(' ');
        orderByClause = `(CASE d.id ${caseWhen} ELSE ${pinnedDomainIds.length} END) ASC, d.id ASC`;
      } else {
        // SQLite: 使用 CASE WHEN（与 PostgreSQL 相同
        const caseWhen = pinnedDomainIds.map((id, index) => `WHEN ${id} THEN ${index}`).join(' ');
        orderByClause = `(CASE d.id ${caseWhen} ELSE ${pinnedDomainIds.length} END) ASC, d.id ASC`;
      }
    } else {
      orderByClause = 'd.id ASC';
    }

    // 当使用 domain_match 时，按域名长度降序排列（最具体匹配优先）
    if (domainMatch && orderByClause) {
      orderByClause = orderByClause.replace('d.id ASC', 'LENGTH(d.name) DESC, d.id ASC');
    }

    // 查询总数
    const countSql = `SELECT COUNT(*) as count FROM (${baseSql}) as subquery`;
    const countResult = await queryInternal(countSql, baseParams, {
      operation: 'Domain.getAccessibleDomainsWithPagination.count',
      table: 'domains'
    });
    const total = Number((countResult[0] as any)?.count || 0);

    // 查询分页数据
    const offset = (page - 1) * pageSize;

    // MySQL 不支持在 prepared statement 中对 LIMIT/OFFSET 使用参数化占位符
    // 需要直接将整数值拼接到 SQL 中（已验证为整数，安全）
    const paginatedSql = `${baseSql.replace(/ORDER BY [^)]+$/, '')} ORDER BY ${orderByClause} LIMIT ${parseInt(String(pageSize), 10)} OFFSET ${parseInt(String(offset), 10)}`;

    const list = await queryInternal(paginatedSql, baseParams, {
      operation: 'Domain.getAccessibleDomainsWithPagination.list',
      table: 'domains'
    });

    return { list, total };
  },

  /** 检查用户是否有权限访问特定域名（用于令牌权限验证） */
  async checkUserDomainAccess(domainId: number, userId: number): Promise<boolean> {
    const builder = DomainQueryBuilder.checkUserAccess(domainId, userId);
    const { sql, params } = builder.build();

    const result = await getInternal<{ id: number }>(sql, params, {
      operation: 'Domain.checkUserDomainAccess',
      table: 'domains'
    });

    return !!result;
  },

  /** 设置域名的启用状*/
  async setEnabled(id: number, enabled: number): Promise<void> {
    await executeInternal(
      'UPDATE domains SET enabled = ? WHERE id = ?',
      [enabled, id],
      { operation: 'Domain.setEnabled', table: 'domains' }
    );
  },

  /** 获取用户可访问的域名列表（用于令牌创建，只显示启用账号的域名*/
  async getUserAccessibleDomains(userId: number): Promise<QueryResult[]> {
    return queryInternal(
      `SELECT d.id, d.name, da.name as account_name
       FROM domains d
       JOIN dns_accounts da ON d.account_id = da.id
       WHERE da.enabled = 1
         AND (da.created_by = ? OR d.id IN (
           SELECT domain_id FROM domain_permissions WHERE user_id = ?
         ))
       ORDER BY d.name`,
      [userId, userId],
      { operation: 'Domain.getUserAccessibleDomains', table: 'domains' }
    );
  },

  /** 获取 NS 监控可用的域名列表（Level 1 - ALL，不过滤 enabled 状态） */
  async getAvailableDomainsForNSMonitor(userId: number, isSuperAdmin: boolean): Promise<QueryResult[]> {
    let builder: DomainQueryBuilder;

    if (isSuperAdmin) {
      // Super admin: reuse getAll() pattern but select specific columns
      builder = DomainQueryBuilder.all().select('d.id, d.name, d.account_id').orderByColumn('d.name');
    } else {
      // Regular user: use dedicated builder
      builder = DomainQueryBuilder.forNSMonitorUser(userId)
        .select('d.id, d.name, d.account_id')
        .orderByColumn('d.name');
    }

    const { sql, params } = builder.build();
    return queryInternal(sql, params, {
      operation: isSuperAdmin
        ? 'Domain.getAvailableDomainsForNSMonitor.super'
        : 'Domain.getAvailableDomainsForNSMonitor.user',
      table: 'domains'
    });
  },
};

// ============================================================================
// 团队业务操作
// ============================================================================

export const TeamOperations = {
  /** 根据ID获取团队 */
  async getById(id: number): Promise<QueryResult | undefined> {
    return getInternal('SELECT * FROM teams WHERE id = ?', [id], { operation: 'Team.getById', table: 'teams' });
  },

  /** 获取所有团*/
  async getAll(): Promise<QueryResult[]> {
    return queryInternal('SELECT * FROM teams ORDER BY id', [], { operation: 'Team.getAll', table: 'teams' });
  },

  /** 获取用户所属团*/
  async getByUserId(userId: number): Promise<QueryResult[]> {
    return queryInternal(
      `SELECT t.* FROM teams t
       INNER JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ?
       ORDER BY t.id`,
      [userId],
      { operation: 'Team.getByUserId', table: 'teams' }
    );
  },

  /** 创建团队 */
  async create(data: { name: string; description: string; created_by: number }): Promise<number> {
    return insertInternal(
      'INSERT INTO teams (name, description, created_by) VALUES (?, ?, ?)',
      [data.name, data.description, data.created_by],
      { operation: 'Team.create', table: 'teams' }
    );
  },

  /** 更新团队 */
  async update(id: number, updates: Record<string, unknown>): Promise<void> {
    const fields = Object.keys(updates);
    if (fields.length === 0) return;

    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = Object.values(updates);

    return executeInternal(
      `UPDATE teams SET ${setClause} WHERE id = ?`,
      [...values, id],
      { operation: 'Team.update', table: 'teams' }
    );
  },

  /** 删除团队 */
  async delete(id: number): Promise<void> {
    return executeInternal('DELETE FROM teams WHERE id = ?', [id], { operation: 'Team.delete', table: 'teams' });
  },

  /** 添加团队成员 */
  async addMember(teamId: number, userId: number, role: string): Promise<void> {
    return executeInternal(
      'INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)',
      [teamId, userId, role],
      { operation: 'Team.addMember', table: 'team_members' }
    );
  },

  /** 获取团队成员 */
  async getMembers(teamId: number): Promise<QueryResult[]> {
    return queryInternal(
      `SELECT tm.*, u.username, u.nickname, u.email FROM team_members tm
       INNER JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = ?`,
      [teamId],
      { operation: 'Team.getMembers', table: 'team_members' }
    );
  },

  /** 检查用户是否在团队*/
  async isMember(teamId: number, userId: number): Promise<boolean> {
    const result = await getInternal<{ id: number }>(
      'SELECT id FROM team_members WHERE team_id = ? AND user_id = ?',
      [teamId, userId],
      { operation: 'Team.isMember', table: 'team_members' }
    );
    return !!result;
  },

  /** 移除团队成员 */
  async removeMember(teamId: number, userId: number): Promise<void> {
    return executeInternal(
      'DELETE FROM team_members WHERE team_id = ? AND user_id = ?',
      [teamId, userId],
      { operation: 'Team.removeMember', table: 'team_members' }
    );
  },

  /** 更新团队成员角色 */
  async updateMemberRole(teamId: number, userId: number, role: string): Promise<void> {
    return executeInternal(
      'UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?',
      [role, teamId, userId],
      { operation: 'Team.updateMemberRole', table: 'team_members' }
    );
  },

  /** 获取用户的所有团队ID */
  async getTeamIdsByUserId(userId: number): Promise<number[]> {
    const results = await queryInternal<{ team_id: number }>(
      'SELECT team_id FROM team_members WHERE user_id = ?',
      [userId],
      { operation: 'Team.getTeamIdsByUserId', table: 'team_members' }
    );
    return results.map(r => r.team_id);
  },

  /** 获取团队成员及其角色 */
  async getMemberWithRole(teamId: number, userId: number): Promise<{ id: number; role: string } | undefined> {
    return getInternal<{ id: number; role: string }>(
      'SELECT id, role FROM team_members WHERE team_id = ? AND user_id = ?',
      [teamId, userId],
      { operation: 'Team.getMemberWithRole', table: 'team_members' }
    );
  },
};

// ============================================================================
// 系统设置业务操作
// ============================================================================

export const SettingsOperations = {
  /** 获取设置*/
  async get(key: string): Promise<string | undefined> {
    const result = await getInternal<{ value: string }>(
      'SELECT value FROM system_settings WHERE key = ?',
      [key],
      { operation: 'Settings.get', table: 'system_settings' }
    );
    return result?.value;
  },

  /** 设置*/
  async set(key: string, value: string): Promise<void> {
    const { sql, params } = buildUpsertSql(
      'system_settings',
      ['key', 'value'],
      [key, value],
      'key',
      ['value']
    );

    return executeInternal(sql, params, { operation: 'Settings.set', table: 'system_settings' });
  },

  /** 获取JSON设置 */
  async getJson<T>(key: string, defaultValue: T): Promise<T> {
    const value = await this.get(key);
    if (!value) return defaultValue;
    try {
      return JSON.parse(value) as T;
    } catch {
      return defaultValue;
    }
  },

  /** 设置JSON*/
  async setJson(key: string, value: unknown): Promise<void> {
    return this.set(key, JSON.stringify(value));
  },
};

// ============================================================================
// 审计日志业务操作
// ============================================================================

export const AuditOperations = {
  /** 记录审计日志 */
  async log(data: { user_id: number; action: string; target_type?: string; target_id?: string; details?: string }): Promise<void> {
    return executeInternal(
      'INSERT INTO operation_logs (user_id, action, domain, data, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
      [data.user_id, data.action, data.target_type ?? '', data.details ?? null],
      { operation: 'Audit.log', table: 'operation_logs' }
    );
  },

  /** 获取审计日志 */
  async getLogs(options: { userId?: number; action?: string; limit?: number; offset?: number } = {}): Promise<QueryResult[]> {
    let sql = 'SELECT * FROM operation_logs WHERE 1=1';
    const params: unknown[] = [];

    if (options.userId) {
      sql += ' AND user_id = ?';
      params.push(options.userId);
    }

    if (options.action) {
      sql += ' AND action = ?';
      params.push(options.action);
    }

    sql += ' ORDER BY created_at DESC';

    // MySQL LIMIT/OFFSET 需要直接嵌入数
    const dbType = getDbType();
    if (options.limit) {
      if (dbType === 'mysql') {
        sql += ` LIMIT ${Number(options.limit)}`;
      } else {
        sql += ' LIMIT ?';
        params.push(Number(options.limit));
      }
    }

    if (options.offset) {
      if (dbType === 'mysql') {
        sql += ` OFFSET ${Number(options.offset)}`;
      } else {
        sql += ' OFFSET ?';
        params.push(Number(options.offset));
      }
    }

    return queryInternal(sql, params, { operation: 'Audit.getLogs', table: 'audit_logs' });
  },
};

// ============================================================================
// 通知渠道业务操作
// ============================================================================

export const NotificationOperations = {
  /** 获取通知渠道配置 */
  async getChannels(): Promise<string | undefined> {
    return SettingsOperations.get('notification_channels');
  },

  /** 保存通知渠道配置 */
  async saveChannels(config: string): Promise<void> {
    return SettingsOperations.set('notification_channels', config);
  },
};

// ============================================================================
// 审计规则业务操作
// ============================================================================

export const AuditRuleOperations = {
  /** 获取审计规则 */
  async getRules(): Promise<string | undefined> {
    return SettingsOperations.get('audit_rules');
  },

  /** 保存审计规则 */
  async saveRules(rules: string): Promise<void> {
    return SettingsOperations.set('audit_rules', rules);
  },
};

// ============================================================================
// 域名过期通知业务操作
// ============================================================================

export const DomainExpiryOperations = {
  /** 获取过期通知配置 */
  async getNotification(): Promise<string | undefined> {
    return SettingsOperations.get('domain_expiry_notification');
  },

  /** 保存过期通知配置 */
  async saveNotification(config: string): Promise<void> {
    return SettingsOperations.set('domain_expiry_notification', config);
  },

  /** 获取过期天数 */
  async getDays(): Promise<string | undefined> {
    return SettingsOperations.get('domain_expiry_days');
  },

  /** 保存过期天数 */
  async saveDays(days: string): Promise<void> {
    return SettingsOperations.set('domain_expiry_days', days);
  },
};

// ============================================================================
// 2FA 业务操作
// ============================================================================

export const TwoFAOperations = {
  /** 获取用户2FA 配置 */
  async getByUserIdAndType(userId: number, type: string): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT * FROM user_2fa WHERE user_id = ? AND type = ?',
      [userId, type],
      { operation: 'TwoFA.getByUserIdAndType', table: 'user_2fa' }
    );
  },

  /** 检查是否启用了 WebAuthn */
  async isWebAuthnEnabled(userId: number): Promise<boolean> {
    const result = await getInternal<{ enabled: number }>(
      'SELECT enabled FROM user_2fa WHERE user_id = ? AND type = ?',
      [userId, 'webauthn'],
      { operation: 'TwoFA.isWebAuthnEnabled', table: 'user_2fa' }
    );
    return Boolean(result?.enabled);
  },

  /** 获取 TOTP 密钥 */
  async getTOTPSecret(userId: number): Promise<string | undefined> {
    const result = await getInternal<{ secret: string }>(
      'SELECT secret FROM user_2fa WHERE user_id = ? AND type = ?',
      [userId, 'totp'],
      { operation: 'TwoFA.getTOTPSecret', table: 'user_2fa' }
    );
    return result?.secret;
  },

  /** 创建或更2FA 配置 */
  async upsert(data: { user_id: number; type: string; secret?: string; enabled?: boolean }): Promise<void> {
    const { sql, params } = buildUpsertSql(
      'user_2fa',
      ['user_id', 'type', 'secret', 'enabled', 'updated_at'],
      [data.user_id, data.type, data.secret ?? null, data.enabled ? 1 : 0, 'NOW()'],
      'user_id,type',
      ['secret', 'enabled', 'updated_at']
    );
    return executeInternal(sql, params, { operation: 'TwoFA.upsert', table: 'user_2fa' });
  },

  /** 删除 2FA 配置 */
  async delete(userId: number, type: string): Promise<void> {
    return executeInternal(
      'DELETE FROM user_2fa WHERE user_id = ? AND type = ?',
      [userId, type],
      { operation: 'TwoFA.delete', table: 'user_2fa' }
    );
  },
};

// ============================================================================
// OAuth 用户链接业务操作
// ============================================================================

export const OAuthOperations = {
  /** 根据 provider subject 获取用户链接 */
  async getByProviderSubject(provider: string, subject: string): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT * FROM oauth_user_links WHERE provider = ? AND subject = ?',
      [provider, subject],
      { operation: 'OAuth.getByProviderSubject', table: 'oauth_user_links' }
    );
  },

  /** 根据 provider subject 获取用户完整信息（包JOIN users*/
  async getUserByProviderSubject(provider: string, subject: string): Promise<QueryResult | undefined> {
    return getInternal(
      `SELECT l.user_id, u.id, u.username, u.nickname, u.email, u.role_level as role, u.role_level, u.role as role_name, u.status
       FROM oauth_user_links l
       INNER JOIN users u ON u.id = l.user_id
       WHERE l.provider = ? AND l.subject = ?`,
      [provider, subject],
      { operation: 'OAuth.getUserByProviderSubject', table: 'oauth_user_links' }
    );
  },

  /** 获取用户的所OAuth 绑定 */
  async getByUserId(userId: number): Promise<QueryResult[]> {
    return queryInternal(
      'SELECT provider, subject, email, created_at FROM oauth_user_links WHERE user_id = ? ORDER BY id DESC',
      [userId],
      { operation: 'OAuth.getByUserId', table: 'oauth_user_links' }
    );
  },

  /** 创建 OAuth 用户链接 */
  async create(userId: number, provider: string, subject: string, email: string): Promise<void> {
    return executeInternal(
      'INSERT INTO oauth_user_links (user_id, provider, subject, email) VALUES (?, ?, ?, ?)',
      [userId, provider, subject, email],
      { operation: 'OAuth.create', table: 'oauth_user_links' }
    );
  },

  /** 删除 OAuth 用户链接 */
  async delete(userId: number, provider: string): Promise<void> {
    return executeInternal(
      'DELETE FROM oauth_user_links WHERE user_id = ? AND provider = ?',
      [userId, provider],
      { operation: 'OAuth.delete', table: 'oauth_user_links' }
    );
  },

  // ============================================================================
  // OAuth State 管理（用于回调验证）
  // ============================================================================

  /**
   * 将日期格式化为数据库兼容的格(YYYY-MM-DD HH:mm:ss)
   */
  formatDateForDB(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  },

  /** 创建 OAuth state */
  async createState(state: string, mode: 'login' | 'bind', provider: string, userId: number | null, expiresAt: Date): Promise<void> {
    // 使用数据库兼容的日期格式
    const expiresStr = this.formatDateForDB(expiresAt);
    log.debug('Creating state', {
      state: state.substring(0, 16) + '...',
      mode,
      provider,
      userId,
      expiresAt: expiresStr
    });
    return executeInternal(
      'INSERT INTO oauth_states (state, mode, provider, user_id, expires_at) VALUES (?, ?, ?, ?, ?)',
      [state, mode, provider, userId, expiresStr],
      { operation: 'OAuth.createState', table: 'oauth_states' }
    );
  },

  /** 获取并删OAuth state（一次性使用） */
  async getAndDeleteState(state: string): Promise<{ mode: 'login' | 'bind'; provider: 'custom' | 'logto'; userId: number | null; expiresAt: Date } | undefined> {
    const result = await getInternal<{ mode: string; provider: string; user_id: number | null; expires_at: string }>(
      'SELECT mode, provider, user_id, expires_at FROM oauth_states WHERE state = ?',
      [state],
      { operation: 'OAuth.getState', table: 'oauth_states' }
    );

    log.debug('Getting state', {
      state: state.substring(0, 16) + '...',
      found: !!result,
      result
    });

    if (!result) return undefined;

    // 删除已使用的 state
    await executeInternal(
      'DELETE FROM oauth_states WHERE state = ?',
      [state],
      { operation: 'OAuth.deleteState', table: 'oauth_states' }
    );

    return {
      mode: result.mode as 'login' | 'bind',
      provider: result.provider as 'custom' | 'logto',
      userId: result.user_id,
      expiresAt: new Date(result.expires_at),
    };
  },

  /** 清理过期OAuth states */
  async cleanupExpiredStates(): Promise<number> {
    const expiresStr = this.formatDateForDB(new Date());
    const result = await runInternal(
      'DELETE FROM oauth_states WHERE expires_at < ?',
      [expiresStr],
      { operation: 'OAuth.cleanupExpiredStates', table: 'oauth_states' }
    );
    return result.changes || 0;
  },
};

// ============================================================================
// API 令牌业务操作
// ============================================================================

export const TokenOperations = {
  /** 根据 ID 获取令牌 */
  async getById(id: number): Promise<QueryResult | undefined> {
    return getInternal('SELECT * FROM user_tokens WHERE id = ?', [id], { operation: 'Token.getById', table: 'user_tokens' });
  },

  /** 获取用户的所有令*/
  async getByUserId(userId: number): Promise<QueryResult[]> {
    return queryInternal(
      'SELECT * FROM user_tokens WHERE user_id = ? ORDER BY created_at DESC',
      [userId],
      { operation: 'Token.getByUserId', table: 'user_tokens' }
    );
  },

  /** 根据 token_hash 获取令牌 */
  async getByTokenHash(tokenHash: string): Promise<QueryResult | undefined> {
    return getInternal('SELECT * FROM user_tokens WHERE token_hash = ?', [tokenHash], { operation: 'Token.getByTokenHash', table: 'user_tokens' });
  },

  /** 创建令牌 */
  async create(data: {
    user_id: number;
    name: string;
    token_hash: string;
    allowed_domains: string;
    allowed_services: string;
    start_time?: string | null;
    end_time?: string | null;
    max_role: number;
  }): Promise<number> {
    return insertInternal(
      'INSERT INTO user_tokens (user_id, name, token_hash, allowed_domains, allowed_services, start_time, end_time, max_role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [data.user_id, data.name, data.token_hash, data.allowed_domains, data.allowed_services, data.start_time ?? null, data.end_time ?? null, data.max_role],
      { operation: 'Token.create', table: 'user_tokens' }
    );
  },

  /** 更新令牌状*/
  async updateStatus(id: number, isActive: boolean): Promise<void> {
    return executeInternal(
      'UPDATE user_tokens SET is_active = ? WHERE id = ?',
      [isActive ? 1 : 0, id],
      { operation: 'Token.updateStatus', table: 'user_tokens' }
    );
  },

  /** 更新最后使用时*/
  async updateLastUsed(id: number): Promise<void> {
    return executeInternal(
      'UPDATE user_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?',
      [id],
      { operation: 'Token.updateLastUsed', table: 'user_tokens' }
    );
  },

  /** 删除令牌 */
  async delete(id: number): Promise<void> {
    return executeInternal('DELETE FROM user_tokens WHERE id = ?', [id], { operation: 'Token.delete', table: 'user_tokens' });
  },

  /** 删除指定用户的令*/
  async deleteByUser(tokenId: number, userId: number): Promise<void> {
    return executeInternal(
      'DELETE FROM user_tokens WHERE id = ? AND user_id = ?',
      [tokenId, userId],
      { operation: 'Token.deleteByUser', table: 'user_tokens' }
    );
  },

  /** 切换令牌状态（带用户验证） */
  async toggleStatusByUser(tokenId: number, userId: number, isActive: boolean): Promise<void> {
    return executeInternal(
      `UPDATE user_tokens SET is_active = ? WHERE id = ? AND user_id = ?`,
      [isActive ? 1 : 0, tokenId, userId],
      { operation: 'Token.toggleStatusByUser', table: 'user_tokens' }
    );
  },

  /** 更新令牌权限（带用户验证*/
  async updateByUser(
    tokenId: number,
    userId: number,
    data: {
      name?: string;
      allowed_domains?: string;
      allowed_services?: string;
      start_time?: string | null;
      end_time?: string | null;
    }
  ): Promise<void> {
    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    if (data.name !== undefined) {
      fields.push('name = ?');
      values.push(data.name);
    }
    if (data.allowed_domains !== undefined) {
      fields.push('allowed_domains = ?');
      values.push(data.allowed_domains);
    }
    if (data.allowed_services !== undefined) {
      fields.push('allowed_services = ?');
      values.push(data.allowed_services);
    }
    if (data.start_time !== undefined) {
      fields.push('start_time = ?');
      values.push(data.start_time);
    }
    if (data.end_time !== undefined) {
      fields.push('end_time = ?');
      values.push(data.end_time);
    }

    if (fields.length === 0) {
      return;
    }

    values.push(tokenId, userId);

    return executeInternal(
      `UPDATE user_tokens SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`,
      values,
      { operation: 'Token.updateByUser', table: 'user_tokens' }
    );
  },
};

// ============================================================================
// 域名权限业务操作
// ============================================================================

export const DomainPermissionOperations = {
  /** 获取域名的所有权限规*/
  async getByDomainId(domainId: number): Promise<QueryResult[]> {
    return queryInternal(
      'SELECT * FROM domain_permissions WHERE domain_id = ?',
      [domainId],
      { operation: 'DomainPermission.getByDomainId', table: 'domain_permissions' }
    );
  },

  /** 获取用户的域名权*/
  async getByDomainAndUser(domainId: number, userId: number): Promise<QueryResult[]> {
    return queryInternal(
      'SELECT permission, sub FROM domain_permissions WHERE domain_id = ? AND user_id = ?',
      [domainId, userId],
      { operation: 'DomainPermission.getByDomainAndUser', table: 'domain_permissions' }
    );
  },

  /** 获取用户的团队域名权*/
  async getByDomainAndTeamMember(domainId: number, userId: number): Promise<QueryResult[]> {
    return queryInternal(
      `SELECT dp.permission, dp.sub
       FROM domain_permissions dp
       INNER JOIN team_members tm ON tm.team_id = dp.team_id
       WHERE dp.domain_id = ? AND tm.user_id = ?`,
      [domainId, userId],
      { operation: 'DomainPermission.getByDomainAndTeamMember', table: 'domain_permissions' }
    );
  },

  /** 检查域名是否有权限规则 */
  async hasRules(domainId: number): Promise<boolean> {
    const result = await getInternal<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM domain_permissions WHERE domain_id = ?',
      [domainId],
      { operation: 'DomainPermission.hasRules', table: 'domain_permissions' }
    );
    return (result?.cnt || 0) > 0;
  },

  /** 创建权限规则 */
  async create(data: {
    domain_id: number;
    user_id?: number | null;
    team_id?: number | null;
    permission: 'read' | 'write';
    sub?: string;
  }): Promise<number> {
    return insertInternal(
      'INSERT INTO domain_permissions (domain_id, user_id, team_id, permission, sub) VALUES (?, ?, ?, ?, ?)',
      [data.domain_id, data.user_id ?? null, data.team_id ?? null, data.permission, data.sub ?? null],
      { operation: 'DomainPermission.create', table: 'domain_permissions' }
    );
  },

  /** 删除权限规则 */
  async delete(id: number): Promise<void> {
    return executeInternal('DELETE FROM domain_permissions WHERE id = ?', [id], { operation: 'DomainPermission.delete', table: 'domain_permissions' });
  },

  /** 删除域名的所有权*/
  async deleteByDomainId(domainId: number): Promise<void> {
    return executeInternal(
      'DELETE FROM domain_permissions WHERE domain_id = ?',
      [domainId],
      { operation: 'DomainPermission.deleteByDomainId', table: 'domain_permissions' }
    );
  },

  /** 获取团队的域名权限列*/
  async getByTeamId(teamId: number): Promise<QueryResult[]> {
    return queryInternal(
      `SELECT dp.*, d.name as domain_name
       FROM domain_permissions dp
       INNER JOIN domains d ON d.id = dp.domain_id
       WHERE dp.team_id = ?
       ORDER BY d.name`,
      [teamId],
      { operation: 'DomainPermission.getByTeamId', table: 'domain_permissions' }
    );
  },

  /** 根据团队ID、域名ID和子域名获取权限 */
  async getByTeamDomainAndSub(teamId: number, domainId: number, sub: string): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT id FROM domain_permissions WHERE team_id = ? AND domain_id = ? AND sub = ?',
      [teamId, domainId, sub],
      { operation: 'DomainPermission.getByTeamDomainAndSub', table: 'domain_permissions' }
    );
  },

  /** 更新权限 */
  async updatePermission(id: number, permission: 'read' | 'write'): Promise<void> {
    return executeInternal(
      'UPDATE domain_permissions SET permission = ? WHERE id = ?',
      [permission, id],
      { operation: 'DomainPermission.updatePermission', table: 'domain_permissions' }
    );
  },

  /** 删除团队权限 */
  async deleteByTeamAndId(id: number, teamId: number): Promise<void> {
    return executeInternal(
      'DELETE FROM domain_permissions WHERE id = ? AND team_id = ?',
      [id, teamId],
      { operation: 'DomainPermission.deleteByTeamAndId', table: 'domain_permissions' }
    );
  },

  /** 获取用户的域名权限列表（带域名名称） */
  async getByUserIdWithDomainName(userId: number): Promise<QueryResult[]> {
    return queryInternal(
      `SELECT dp.*, d.name as domain_name
       FROM domain_permissions dp
       INNER JOIN domains d ON d.id = dp.domain_id
       WHERE dp.user_id = ?
       ORDER BY d.name`,
      [userId],
      { operation: 'DomainPermission.getByUserIdWithDomainName', table: 'domain_permissions' }
    );
  },

  /** 根据用户ID、域名ID和子域名获取权限 */
  async getByUserDomainAndSub(userId: number, domainId: number, sub: string): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT id FROM domain_permissions WHERE user_id = ? AND domain_id = ? AND sub = ?',
      [userId, domainId, sub],
      { operation: 'DomainPermission.getByUserDomainAndSub', table: 'domain_permissions' }
    );
  },

  /** 删除用户权限 */
  async deleteByUserAndId(id: number, userId: number): Promise<void> {
    return executeInternal(
      'DELETE FROM domain_permissions WHERE id = ? AND user_id = ?',
      [id, userId],
      { operation: 'DomainPermission.deleteByUserAndId', table: 'domain_permissions' }
    );
  },
};

// ============================================================================
// DNS 记录业务操作
// ============================================================================

export const RecordOperations = {
  /** 根据 ID 获取记录 */
  async getById(id: number): Promise<QueryResult | undefined> {
    return getInternal('SELECT * FROM records WHERE id = ?', [id], { operation: 'Record.getById', table: 'records' });
  },

  /** 获取域名的所有记*/
  async getByDomainId(domainId: number): Promise<QueryResult[]> {
    return queryInternal(
      'SELECT * FROM records WHERE domain_id = ? ORDER BY id',
      [domainId],
      { operation: 'Record.getByDomainId', table: 'records' }
    );
  },

  /** 创建记录 */
  async create(data: {
    domain_id: number;
    name: string;
    type: string;
    content: string;
    ttl?: number;
    priority?: number;
    third_id?: string;
  }): Promise<number> {
    return insertInternal(
      'INSERT INTO records (domain_id, name, type, content, ttl, priority, third_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [data.domain_id, data.name, data.type, data.content, data.ttl ?? 3600, data.priority ?? 0, data.third_id ?? null],
      { operation: 'Record.create', table: 'records' }
    );
  },

  /** 更新记录 */
  async update(id: number, updates: Record<string, unknown>): Promise<void> {
    const fields = Object.keys(updates);
    if (fields.length === 0) return;

    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = Object.values(updates);

    return executeInternal(
      `UPDATE records SET ${setClause} WHERE id = ?`,
      [...values, id],
      { operation: 'Record.update', table: 'records' }
    );
  },

  /** 删除记录 */
  async delete(id: number): Promise<void> {
    return executeInternal('DELETE FROM records WHERE id = ?', [id], { operation: 'Record.delete', table: 'records' });
  },

  /** 删除域名的所有记*/
  async deleteByDomainId(domainId: number): Promise<void> {
    return executeInternal(
      'DELETE FROM records WHERE domain_id = ?',
      [domainId],
      { operation: 'Record.deleteByDomainId', table: 'records' }
    );
  },
};

// ============================================================================
// 邮件模板业务操作
// ============================================================================

export const EmailTemplateOperations = {
  /** 获取所有模*/
  async getAll(): Promise<QueryResult[]> {
    return queryInternal(
      'SELECT * FROM email_templates ORDER BY id',
      [],
      { operation: 'EmailTemplate.getAll', table: 'email_templates' }
    );
  },

  /** 根据 ID 获取模板 */
  async getById(id: number): Promise<QueryResult | undefined> {
    return getInternal('SELECT * FROM email_templates WHERE id = ?', [id], { operation: 'EmailTemplate.getById', table: 'email_templates' });
  },

  /** 根据类型获取模板 */
  async getByType(type: string): Promise<QueryResult | undefined> {
    return getInternal('SELECT * FROM email_templates WHERE type = ?', [type], { operation: 'EmailTemplate.getByType', table: 'email_templates' });
  },

  /** 创建模板 */
  async create(data: { type: string; subject: string; body: string }): Promise<number> {
    return insertInternal(
      'INSERT INTO email_templates (type, subject, body) VALUES (?, ?, ?)',
      [data.type, data.subject, data.body],
      { operation: 'EmailTemplate.create', table: 'email_templates' }
    );
  },

  /** 更新模板 */
  async update(id: number, updates: { subject?: string; body?: string }): Promise<void> {
    const fields = Object.keys(updates);
    if (fields.length === 0) return;

    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = Object.values(updates);

    return executeInternal(
      `UPDATE email_templates SET ${setClause} WHERE id = ?`,
      [...values, id],
      { operation: 'EmailTemplate.update', table: 'email_templates' }
    );
  },

  /** 删除模板 */
  async delete(id: number): Promise<void> {
    return executeInternal('DELETE FROM email_templates WHERE id = ?', [id], { operation: 'EmailTemplate.delete', table: 'email_templates' });
  },
};

// ============================================================================
// 事务支持
// ============================================================================

/** 在事务中执行函数 */
export async function withTransaction<T>(fn: (trx: TransactionOperations) => Promise<T>): Promise<T> {
  log.info( 'Starting transaction block');
  const startTime = Date.now();

  try {
    const result = await transaction(async (trx: {
      query: <U>(sql: string, params?: unknown[]) => Promise<U[]>;
      get: <U>(sql: string, params?: unknown[]) => Promise<U | undefined>;
      execute: (sql: string, params?: unknown[]) => Promise<void>;
      insert: (sql: string, params?: unknown[]) => Promise<number>;
      run: (sql: string, params?: unknown[]) => Promise<{ changes: number }>;
    }) => {
      const trxOps = new TransactionOperations(trx);
      return fn(trxOps);
    });

    const duration = Date.now() - startTime;
    log.info( `Transaction block completed`, { duration: `${duration}ms` });
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    log.error( 'Transaction block failed', { error, duration: `${duration}ms` });
    throw error;
  }
}

/** 事务操作*/
export class TransactionOperations {
  private trx: {
    query: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
    get: <T>(sql: string, params?: unknown[]) => Promise<T | undefined>;
    execute: (sql: string, params?: unknown[]) => Promise<void>;
    insert: (sql: string, params?: unknown[]) => Promise<number>;
    run: (sql: string, params?: unknown[]) => Promise<{ changes: number }>;
  };

  constructor(trx: TransactionOperations['trx']) {
    this.trx = trx;
  }

  async query<T = QueryResult>(sql: string, params?: unknown[]): Promise<T[]> {
    const processedSql = processSql(sql, db.type);
    log.debug( '[Transaction] Executing query', { sql: processedSql });
    return this.trx.query<T>(processedSql, params);
  }

  async get<T = QueryResult>(sql: string, params?: unknown[]): Promise<T | undefined> {
    const processedSql = processSql(sql, db.type);
    log.debug( '[Transaction] Executing get', { sql: processedSql });
    return this.trx.get<T>(processedSql, params);
  }

  async execute(sql: string, params?: unknown[]): Promise<void> {
    const processedSql = processSql(sql, db.type);
    log.debug( '[Transaction] Executing execute', { sql: processedSql });
    return this.trx.execute(processedSql, params);
  }

  async insert(sql: string, params?: unknown[]): Promise<number> {
    const processedSql = processSql(sql, db.type);
    log.debug( '[Transaction] Executing insert', { sql: processedSql });
    return this.trx.insert(processedSql, params);
  }

  async run(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    const processedSql = processSql(sql, db.type);
    log.debug( '[Transaction] Executing run', { sql: processedSql });
    return this.trx.run(processedSql, params);
  }
}

// ============================================================================
// 系统信息业务操作
// ============================================================================

export const SystemOperations = {
  /** 获取数据库信息（版本、驱动等*/
  async getDatabaseInfo(): Promise<{ type: string; version: string; driverVersion: string }> {
    const conn = getConnection();

    let dbInfo = {
      type: conn.type,
      version: 'unknown',
      driverVersion: 'unknown',
    };

    if (conn.type === 'sqlite') {
      // Get SQLite version
      const result = await conn.get('SELECT sqlite_version() as version');
      dbInfo.version = (result as { version: string })?.version || 'unknown';
      dbInfo.driverVersion = 'node:sqlite (built-in)';
    } else if (conn.type === 'mysql') {
      // Get MySQL version
      const result = await conn.get('SELECT VERSION() as version');
      dbInfo.version = (result as { version: string })?.version || 'unknown';
      dbInfo.driverVersion = require('mysql2/package.json').version;
    } else if (conn.type === 'postgresql') {
      // Get PostgreSQL version
      const result = await conn.get('SELECT version() as version');
      const fullVersion = (result as { version: string })?.version || 'unknown';
      // Extract version number from string like "PostgreSQL 15.2 on ..."
      const match = fullVersion.match(/PostgreSQL\s+(\d+\.?\d*)/);
      dbInfo.version = match ? match[1] : fullVersion;
      dbInfo.driverVersion = require('pg/package.json').version;
    }

    return dbInfo;
  },

  /**
   * 测试 SQLite 数据库连接并检查是否有现有数据
   * 注意：此方法使用直接连接进行初始化测试，不是标准业务查询
   */
  async testSqliteConnection(sqlitePath: string): Promise<{ success: boolean; message: string; hasExistingData: boolean; hasUsers?: boolean }> {
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('fs');
    const path = require('path');

    // 统一使用正斜杠，避免 Windows 路径问题
    const normalizedPath = sqlitePath.replace(/\\/g, '/');
    const dir = path.dirname(normalizedPath);

    // 确保目录存在
    if (dir && dir !== '.' && !fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        log.warn('Failed to create directory, may already exist', { dir, error: err });
      }
    }

    let testDb;
    try {
      testDb = new DatabaseSync(normalizedPath);
    } catch (err) {
      log.error('Failed to open SQLite database', { path: normalizedPath, error: err });
      throw err;
    }

    // Check if tables exist
    let hasData = false;
    let hasUsers = false;
    try {
      const tables = testDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
      if (tables.length > 0) {
        hasData = true;
        // Check if users table exists and has data
        const usersTable = tables.find(t => t.name === 'users');
        if (usersTable) {
          const userCount = testDb.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
          hasUsers = userCount?.cnt > 0;
        }
      }
    } catch {
      // No tables yet
    }

    testDb.close();
    return { success: true, message: 'SQLite connection successful', hasExistingData: hasData, hasUsers };
  },

  /**
   * 测试 MySQL 数据库连接并检查是否有现有数据
   * 注意：此方法使用直接连接进行初始化测试，不是标准业务查询
   */
  async testMysqlConnection(config: { host: string; port: number; user: string; password: string; database: string; ssl?: boolean }): Promise<{ success: boolean; message: string; hasExistingData: boolean; hasUsers?: boolean }> {
    const mysql = require('mysql2/promise');

    const pool = mysql.createPool({
      host: config.host,
      port: config.port || 3306,
      user: config.user,
      password: config.password,
      database: config.database,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      connectionLimit: 1,
    });

    // Verify the connection is actually reachable before proceeding
    const conn = await pool.getConnection();
    conn.release();

    // Check if there's any data
    let hasData = false;
    let hasUsers = false;
    try {
      const [tables] = await pool.execute('SHOW TABLES') as [any[], any];
      if (tables && tables.length > 0) {
        hasData = true;
        // Check if users table exists and has data
        const usersTableExists = tables.some(t => Object.values(t)[0] === 'users');
        if (usersTableExists) {
          const [userCountResult] = await pool.execute('SELECT COUNT(*) as cnt FROM users') as [any[], any];
          hasUsers = userCountResult[0]?.cnt > 0;
        }
      }
    } catch {
      // No tables yet
    }

    await pool.end();
    return { success: true, message: 'MySQL connection successful', hasExistingData: hasData, hasUsers };
  },

  /**
   * 测试 PostgreSQL 数据库连接并检查是否有现有数据
   * 注意：此方法使用直接连接进行初始化测试，不是标准业务查询
   */
  async testPostgresqlConnection(config: { host: string; port: number; user: string; password: string; database: string; ssl?: boolean }): Promise<{ success: boolean; message: string; hasExistingData: boolean; hasUsers?: boolean }> {
    const { Pool } = require('pg');

    const pool = new Pool({
      host: config.host,
      port: config.port || 5432,
      user: config.user,
      password: config.password,
      database: config.database,
      ssl: config.ssl ? { rejectUnauthorized: false } : false,
      max: 1,
    });

    // Verify the connection is actually reachable before proceeding
    const client = await pool.connect();
    client.release();

    // Check if there's any data
    let hasData = false;
    let hasUsers = false;
    try {
      const tablesResult = await pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `);
      const tables = tablesResult.rows as { table_name: string }[];
      if (tables && tables.length > 0) {
        hasData = true;
        // Check if users table exists and has data
        const usersTableExists = tables.some(t => t.table_name === 'users');
        if (usersTableExists) {
          const userCountResult = await pool.query('SELECT COUNT(*) as cnt FROM users');
          hasUsers = userCountResult.rows[0]?.cnt > 0;
        }
      }
    } catch {
      // No tables yet
    }

    await pool.end();
    return { success: true, message: 'PostgreSQL connection successful', hasExistingData: hasData, hasUsers };
  },

  /**
   * 统一测试数据库连接（根据类型自动选择
   * 注意：此方法使用直接连接进行初始化测试，不是标准业务查询
   */
  async testConnection(config: {
    type: 'sqlite' | 'mysql' | 'postgresql';
    sqlite?: { path: string };
    mysql?: { host: string; port: number; user: string; password: string; database: string; ssl?: boolean };
    postgresql?: { host: string; port: number; user: string; password: string; database: string; ssl?: boolean }
  }): Promise<{ success: boolean; message: string; hasExistingData: boolean; hasUsers?: boolean }> {
    if (config.type === 'sqlite') {
      return this.testSqliteConnection(config.sqlite?.path || './data/hidns.db');
    } else if (config.type === 'mysql') {
      if (!config.mysql) throw new Error('MySQL configuration required');
      return this.testMysqlConnection(config.mysql);
    } else if (config.type === 'postgresql') {
      if (!config.postgresql) throw new Error('PostgreSQL configuration required');
      return this.testPostgresqlConnection(config.postgresql);
    }
    throw new Error(`Unsupported database type: ${config.type}`);
  },
};

// ============================================================================
// 运行时密钥业务操
// ============================================================================

export const SecretOperations = {
  /** 获取运行时密*/
  async getRuntimeSecret(key: string): Promise<string | undefined> {
    const dbType = getDbType();
    const sql = dbType === 'mysql'
      ? 'SELECT `value` FROM runtime_secrets WHERE `key` = ?'
      : dbType === 'postgresql'
        ? 'SELECT "value" FROM runtime_secrets WHERE "key" = $1'
        : 'SELECT `value` FROM runtime_secrets WHERE `key` = ?';
    const params = dbType === 'postgresql' ? [key] : [key];
    const row = await getInternal<{ value: string }>(
      sql,
      params,
      { operation: 'Secret.getRuntimeSecret', table: 'runtime_secrets' }
    );
    return row?.value;
  },

  /** 确保运行时密钥表存在 */
  async ensureRuntimeSecretsTable(): Promise<void> {
    const dbType = getDbType();
    const sql = dbType === 'mysql'
      ? `CREATE TABLE IF NOT EXISTS runtime_secrets (
        \`key\` VARCHAR(255) PRIMARY KEY,
        \`value\` TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`
      : dbType === 'postgresql'
        ? `CREATE TABLE IF NOT EXISTS runtime_secrets (
        "key" VARCHAR(255) PRIMARY KEY,
        "value" TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`
        : `CREATE TABLE IF NOT EXISTS runtime_secrets (
        \`key\` VARCHAR(255) PRIMARY KEY,
        \`value\` TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`;
    return executeInternal(
      sql,
      [],
      { operation: 'Secret.ensureRuntimeSecretsTable', table: 'runtime_secrets' }
    );
  },

  /** 设置运行时密*/
  async setRuntimeSecret(key: string, value: string): Promise<void> {
    const dbType = getDbType();
    let sql: string;
    let params: unknown[];

    if (dbType === 'mysql') {
      // MySQL: 使用 INSERT ... ON DUPLICATE KEY UPDATE
      sql = 'INSERT INTO runtime_secrets (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)';
      params = [key, value];
    } else if (dbType === 'postgresql') {
      // PostgreSQL: 使用 INSERT ... ON CONFLICT
      sql = 'INSERT INTO runtime_secrets ("key", "value") VALUES ($1, $2) ON CONFLICT("key") DO UPDATE SET "value" = EXCLUDED."value"';
      params = [key, value];
    } else {
      // SQLite: 使用 INSERT ... ON CONFLICT
      sql = 'INSERT INTO runtime_secrets (`key`, `value`) VALUES (?, ?) ON CONFLICT(`key`) DO UPDATE SET `value` = excluded.`value`';
      params = [key, value];
    }

    return executeInternal(
      sql,
      params,
      { operation: 'Secret.setRuntimeSecret', table: 'runtime_secrets' }
    );
  },

  /** 轮换运行时密*/
  async rotateRuntimeSecrets(): Promise<void> {
    try {
      const jwtRuntimeSecret = crypto.randomBytes(32).toString('hex');
      const dbType = getDbType();

      if (dbType === 'sqlite') {
        // SQLite: 使用 executeInternal 执行 SQL
        await executeInternal('DELETE FROM runtime_secrets', [], { operation: 'Secret.rotate.delete', table: 'runtime_secrets' });
        await executeInternal(
          'INSERT INTO runtime_secrets (`key`, `value`) VALUES (?, ?)',
          ['jwt_runtime', jwtRuntimeSecret],
          { operation: 'Secret.rotate.insert', table: 'runtime_secrets' }
        );
      } else if (dbType === 'mysql') {
        // MySQL: 使用 executeInternal 执行 SQL
        await executeInternal('DELETE FROM runtime_secrets', [], { operation: 'Secret.rotate.delete', table: 'runtime_secrets' });
        await executeInternal(
          'INSERT INTO runtime_secrets (`key`, `value`) VALUES (?, ?)',
          ['jwt_runtime', jwtRuntimeSecret],
          { operation: 'Secret.rotate.insert', table: 'runtime_secrets' }
        );
      } else {
        // PostgreSQL: 使用 executeInternal 执行 SQL
        await executeInternal('DELETE FROM runtime_secrets', [], { operation: 'Secret.rotate.delete', table: 'runtime_secrets' });
        await executeInternal(
          'INSERT INTO runtime_secrets ("key", "value") VALUES ($1, $2)',
          ['jwt_runtime', jwtRuntimeSecret],
          { operation: 'Secret.rotate.insert', table: 'runtime_secrets' }
        );
      }

      log.info('Runtime secrets rotated');
    } catch (error) {
      log.error('Error rotating runtime secrets', { error });
      throw error;
    }
  },
};

// ============================================================================
// 安全策略业务操作
// ============================================================================

export const SecurityPolicyOperations = {
  /** 获取当前安全策略 */
  async getPolicy(): Promise<QueryResult | undefined> {
    return getInternal(
      `SELECT id, require_2fa_global as require2FAGlobal, min_password_length as minPasswordLength,
        min_password_strength as minPasswordStrength, session_timeout_hours as sessionTimeoutHours,
        max_login_attempts as maxLoginAttempts, lockout_duration_minutes as lockoutDurationMinutes,
        allow_remember_device as allowRememberDevice, trusted_device_days as trustedDeviceDays,
        require_password_change_on_first_login as requirePasswordChangeOnFirstLogin,
        created_at, updated_at
      FROM security_policies LIMIT 1`,
      [],
      { operation: 'SecurityPolicy.getPolicy', table: 'security_policies' }
    );
  },

  /** 更新安全策略 */
  async updatePolicy(updates: Record<string, unknown>, policyId: number): Promise<void> {
    const fields = Object.keys(updates);
    if (fields.length === 0) return;
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = Object.values(updates);
    return executeInternal(
      `UPDATE security_policies SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [...values, policyId],
      { operation: 'SecurityPolicy.updatePolicy', table: 'security_policies' }
    );
  },

  /** 初始化默认安全策*/
  async initPolicy(values: unknown[]): Promise<void> {
    return executeInternal(
      `INSERT INTO security_policies (
        require_2fa_global, min_password_length, min_password_strength,
        session_timeout_hours, max_login_attempts, lockout_duration_minutes,
        allow_remember_device, trusted_device_days, require_password_change_on_first_login
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      values,
      { operation: 'SecurityPolicy.initPolicy', table: 'security_policies' }
    );
  },

  /** 检查策略是否存*/
  async exists(): Promise<boolean> {
    const result = await getInternal<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM security_policies',
      [],
      { operation: 'SecurityPolicy.exists', table: 'security_policies' }
    );
    return (result?.cnt || 0) > 0;
  },

  /** 获取用户安全设置 */
  async getUserSecuritySetting(userId: number): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT require_2fa FROM user_security_settings WHERE user_id = ?',
      [userId],
      { operation: 'SecurityPolicy.getUserSecuritySetting', table: 'user_security_settings' }
    );
  },

  /** 检查用户是否有 2FA */
  async has2FA(userId: number): Promise<boolean> {
    const dbType = process.env.DB_TYPE || 'sqlite';
    const enabledValue = dbType === 'postgresql' ? '$4' : '?';
    const enabledParam = dbType === 'postgresql' ? [userId, 'totp', 'webauthn', 1] : [userId, 'totp', 'webauthn', 1];

    const sql = dbType === 'postgresql'
      ? 'SELECT COUNT(*) as count FROM user_2fa WHERE user_id = $1 AND type IN ($2, $3) AND enabled = $4'
      : 'SELECT COUNT(*) as count FROM user_2fa WHERE user_id = ? AND type IN (?, ?) AND enabled = ?';

    const result = await getInternal<{ count: number }>(
      sql,
      enabledParam,
      { operation: 'SecurityPolicy.has2FA', table: 'user_2fa' }
    );
    return (result?.count || 0) > 0;
  },

  /** 更新用户 2FA 要求设置 */
  async updateUser2FARequirement(userId: number, require2FA: boolean): Promise<void> {
    const existing = await getInternal<{ id: number }>(
      'SELECT id FROM user_security_settings WHERE user_id = ?',
      [userId],
      { operation: 'SecurityPolicy.updateUser2FARequirement.check', table: 'user_security_settings' }
    );
    if (existing) {
      return executeInternal(
        'UPDATE user_security_settings SET require_2fa = ? WHERE user_id = ?',
        [require2FA ? 1 : 0, userId],
        { operation: 'SecurityPolicy.updateUser2FARequirement.update', table: 'user_security_settings' }
      );
    } else {
      return executeInternal(
        'INSERT INTO user_security_settings (user_id, require_2fa) VALUES (?, ?)',
        [userId, require2FA ? 1 : 0],
        { operation: 'SecurityPolicy.updateUser2FARequirement.insert', table: 'user_security_settings' }
      );
    }
  },
};

// ============================================================================
// 受信任设备业务操
// ============================================================================

export const TrustedDeviceOperations = {
  /** 添加受信任设*/
  async add(deviceId: string, userId: number, deviceName: string, fingerprint: string, userAgent: string, ipAddress: string, expiresAt: string): Promise<void> {
    return executeInternal(
      `INSERT INTO trusted_devices (id, user_id, device_name, device_fingerprint, user_agent, ip_address, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [deviceId, userId, deviceName, fingerprint, userAgent, ipAddress, expiresAt],
      { operation: 'TrustedDevice.add', table: 'trusted_devices' }
    );
  },

  /** 根据指纹获取设备 */
  async getByFingerprint(userId: number, fingerprint: string): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT id, expires_at FROM trusted_devices WHERE user_id = ? AND device_fingerprint = ?',
      [userId, fingerprint],
      { operation: 'TrustedDevice.getByFingerprint', table: 'trusted_devices' }
    );
  },

  /** 更新最后使用时*/
  async updateLastUsed(deviceId: string): Promise<void> {
    return executeInternal(
      'UPDATE trusted_devices SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?',
      [deviceId],
      { operation: 'TrustedDevice.updateLastUsed', table: 'trusted_devices' }
    );
  },

  /** 删除设备 */
  async delete(deviceId: string): Promise<void> {
    return executeInternal(
      'DELETE FROM trusted_devices WHERE id = ?',
      [deviceId],
      { operation: 'TrustedDevice.delete', table: 'trusted_devices' }
    );
  },

  /** 删除用户的所有设*/
  async deleteByUser(userId: number): Promise<void> {
    return executeInternal(
      'DELETE FROM trusted_devices WHERE user_id = ?',
      [userId],
      { operation: 'TrustedDevice.deleteByUser', table: 'trusted_devices' }
    );
  },

  /** 获取用户的所有设*/
  async getByUser(userId: number): Promise<QueryResult[]> {
    return queryInternal(
      `SELECT id, user_id as userId, device_name as deviceName, device_fingerprint as deviceFingerprint,
        user_agent as userAgent, ip_address as ipAddress, last_used_at as lastUsedAt,
        expires_at as expiresAt, created_at as createdAt
      FROM trusted_devices WHERE user_id = ? ORDER BY last_used_at DESC`,
      [userId],
      { operation: 'TrustedDevice.getByUser', table: 'trusted_devices' }
    );
  },

  /** 删除过期设备 */
  async cleanupExpired(): Promise<number> {
    const result = await runInternal(
      'DELETE FROM trusted_devices WHERE expires_at < CURRENT_TIMESTAMP',
      [],
      { operation: 'TrustedDevice.cleanupExpired', table: 'trusted_devices' }
    );
    return result.changes || 0;
  },

  /** 删除指定用户的设*/
  async deleteByUserAndId(userId: number, deviceId: string): Promise<number> {
    const result = await runInternal(
      'DELETE FROM trusted_devices WHERE id = ? AND user_id = ?',
      [deviceId, userId],
      { operation: 'TrustedDevice.deleteByUserAndId', table: 'trusted_devices' }
    );
    return result.changes || 0;
  },
};

// ============================================================================
// 用户偏好设置业务操作
// ============================================================================

export const UserPreferencesOperations = {
  /** 获取用户偏好设置 */
  async get(userId: number): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT user_id, theme, language, notifications_enabled, email_notifications, background_image, avatar_image FROM user_preferences WHERE user_id = ?',
      [userId],
      { operation: 'UserPreferences.get', table: 'user_preferences' }
    );
  },

  /** 更新用户偏好设置 (SQLite) */
  async upsertSQLite(userId: number, theme: string, language: string, notificationsEnabled: number, emailNotifications: number, backgroundImage: string | null, avatarImage: string | null): Promise<void> {
    return executeInternal(
      `INSERT INTO user_preferences (user_id, theme, language, notifications_enabled, email_notifications, background_image, avatar_image, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
        theme = excluded.theme, language = excluded.language,
        notifications_enabled = excluded.notifications_enabled, email_notifications = excluded.email_notifications,
        background_image = excluded.background_image, avatar_image = excluded.avatar_image, updated_at = datetime('now')`,
      [userId, theme, language, notificationsEnabled, emailNotifications, backgroundImage, avatarImage],
      { operation: 'UserPreferences.upsertSQLite', table: 'user_preferences' }
    );
  },

  /** 更新用户偏好设置 (MySQL) */
  async upsertMySQL(userId: number, theme: string, language: string, notificationsEnabled: number, emailNotifications: number, backgroundImage: string | null, avatarImage: string | null): Promise<void> {
    return executeInternal(
      `INSERT INTO user_preferences (user_id, theme, language, notifications_enabled, email_notifications, background_image, avatar_image)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        theme = VALUES(theme), language = VALUES(language),
        notifications_enabled = VALUES(notifications_enabled), email_notifications = VALUES(email_notifications),
        background_image = VALUES(background_image), avatar_image = VALUES(avatar_image)`,
      [userId, theme, language, notificationsEnabled, emailNotifications, backgroundImage, avatarImage],
      { operation: 'UserPreferences.upsertMySQL', table: 'user_preferences' }
    );
  },

  /** 更新用户偏好设置 (PostgreSQL) */
  async upsertPostgreSQL(userId: number, theme: string, language: string, notificationsEnabled: number, emailNotifications: number, backgroundImage: string | null, avatarImage: string | null): Promise<void> {
    return executeInternal(
      `INSERT INTO user_preferences (user_id, theme, language, notifications_enabled, email_notifications, background_image, avatar_image)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(user_id) DO UPDATE SET
        theme = EXCLUDED.theme, language = EXCLUDED.language,
        notifications_enabled = EXCLUDED.notifications_enabled, email_notifications = EXCLUDED.email_notifications,
        background_image = EXCLUDED.background_image, avatar_image = EXCLUDED.avatar_image`,
      [userId, theme, language, notificationsEnabled, emailNotifications, backgroundImage, avatarImage],
      { operation: 'UserPreferences.upsertPostgreSQL', table: 'user_preferences' }
    );
  },

  /** 获取用户置顶的域名列*/
  async getPinnedDomains(userId: number): Promise<number[]> {
    try {
      const result = await getInternal(
        'SELECT pinned_domains FROM user_preferences WHERE user_id = ?',
        [userId],
        { operation: 'UserPreferences.getPinnedDomains', table: 'user_preferences' }
      );

      if (!result || !result.pinned_domains) {
        return [];
      }

      // MySQL JSON 类型直接返回数组，SQLite/PostgreSQL 返回字符
      const pinnedDomains = result.pinned_domains;
      if (Array.isArray(pinnedDomains)) {
        return pinnedDomains;
      }
      // 如果是字符串，解JSON
      if (typeof pinnedDomains === 'string') {
        const parsed = JSON.parse(pinnedDomains);
        return Array.isArray(parsed) ? parsed : [];
      }
      return [];
    } catch (error) {
      // 表或字段不存在时返回空数
      log.warn('Failed to get pinned domains, returning empty array', { userId, error });
      return [];
    }
  },

  /** 更新用户置顶的域名列*/
  async updatePinnedDomains(userId: number, domainIds: number[]): Promise<void> {
    const pinnedDomainsJson = JSON.stringify(domainIds);

    // SQLite
    if (process.env.DB_TYPE === 'sqlite' || !process.env.DB_TYPE) {
      await executeInternal(
        `INSERT INTO user_preferences (user_id, pinned_domains, created_at, updated_at)
         VALUES (?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
          pinned_domains = excluded.pinned_domains, updated_at = datetime('now')`,
        [userId, pinnedDomainsJson],
        { operation: 'UserPreferences.updatePinnedDomains', table: 'user_preferences' }
      );
    } else if (process.env.DB_TYPE === 'mysql') {
      // MySQL
      await executeInternal(
        `INSERT INTO user_preferences (user_id, pinned_domains)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE
          pinned_domains = VALUES(pinned_domains)`,
        [userId, pinnedDomainsJson],
        { operation: 'UserPreferences.updatePinnedDomains', table: 'user_preferences' }
      );
    } else {
      // PostgreSQL
      await executeInternal(
        `INSERT INTO user_preferences (user_id, pinned_domains)
         VALUES ($1, $2::jsonb)
         ON CONFLICT(user_id) DO UPDATE SET
          pinned_domains = EXCLUDED.pinned_domains`,
        [userId, pinnedDomainsJson],
        { operation: 'UserPreferences.updatePinnedDomains', table: 'user_preferences' }
      );
    }
  },
};

// ============================================================================
// 会话管理业务操作
// ============================================================================

export const SessionOperations = {
  /** 创建会话 */
  async create(sessionId: string, userId: number, token: string, ipAddress: string, userAgent: string, expiresAt: string): Promise<void> {
    return executeInternal(
      `INSERT INTO user_sessions (id, user_id, token, ip_address, user_agent, created_at, last_activity_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ${now()}, ${now()}, ?)`,
      [sessionId, userId, token, ipAddress, userAgent, expiresAt],
      { operation: 'Session.create', table: 'user_sessions' }
    );
  },

  /** 获取用户的活跃会*/
  async getActiveByUser(userId: number, nowTime: string): Promise<QueryResult[]> {
    return queryInternal(
      `SELECT id, user_id, token, ip_address, user_agent, created_at, last_activity_at, expires_at
      FROM user_sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_activity_at DESC`,
      [userId, nowTime],
      { operation: 'Session.getActiveByUser', table: 'user_sessions' }
    );
  },

  /** 更新会话活动时间 */
  async updateActivity(sessionId: string): Promise<void> {
    return executeInternal(
      `UPDATE user_sessions SET last_activity_at = ${now()} WHERE id = ?`,
      [sessionId],
      { operation: 'Session.updateActivity', table: 'user_sessions' }
    );
  },

  /** 删除会话 */
  async delete(sessionId: string): Promise<void> {
    return executeInternal(
      'DELETE FROM user_sessions WHERE id = ?',
      [sessionId],
      { operation: 'Session.delete', table: 'user_sessions' }
    );
  },

  /** 删除用户的其他会*/
  async deleteOthers(userId: number, currentSessionId: string): Promise<void> {
    return executeInternal(
      'DELETE FROM user_sessions WHERE user_id = ? AND id != ?',
      [userId, currentSessionId],
      { operation: 'Session.deleteOthers', table: 'user_sessions' }
    );
  },

  /** 删除用户的所有会*/
  async deleteByUser(userId: number): Promise<void> {
    return executeInternal(
      'DELETE FROM user_sessions WHERE user_id = ?',
      [userId],
      { operation: 'Session.deleteByUser', table: 'user_sessions' }
    );
  },

  /** 清理过期会话 */
  async cleanupExpired(nowTime: string): Promise<void> {
    return executeInternal(
      'DELETE FROM user_sessions WHERE expires_at < ?',
      [nowTime],
      { operation: 'Session.cleanupExpired', table: 'user_sessions' }
    );
  },

  /** 根据 token 获取会话 */
  async getByToken(token: string, nowTime: string): Promise<QueryResult | undefined> {
    return getInternal(
      `SELECT id, user_id, token, ip_address, user_agent, created_at, last_activity_at, expires_at
      FROM user_sessions WHERE token = ? AND expires_at > ? LIMIT 1`,
      [token, nowTime],
      { operation: 'Session.getByToken', table: 'user_sessions' }
    );
  },
};

// ============================================================================
// 登录限制业务操作
// ============================================================================

export const LoginLimitOperations = {
  /** 获取登录限制配置 */
  async getConfig(): Promise<QueryResult | undefined> {
    return getInternal(
      "SELECT value FROM system_settings WHERE key = 'login_limit_config'",
      [],
      { operation: 'LoginLimit.getConfig', table: 'system_settings' }
    );
  },

  /** 更新登录限制配置 */
  async updateConfig(configJson: string): Promise<void> {
    const { sql, params } = buildUpsertSql(
      'system_settings',
      ['key', 'value'],
      ['login_limit_config', configJson],
      'key',
      ['value']
    );
    return executeInternal(sql, params, { operation: 'LoginLimit.updateConfig', table: 'system_settings' });
  },

  /** 获取登录尝试记录 */
  async getAttempt(identifier: string): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT * FROM login_attempts WHERE identifier = ? ORDER BY created_at DESC LIMIT 1',
      [identifier.toLowerCase()],
      { operation: 'LoginLimit.getAttempt', table: 'login_attempts' }
    );
  },

  /** 更新登录尝试记录 */
  async updateAttempt(id: number, count: number, lockedUntil: string | null): Promise<void> {
    return executeInternal(
      `UPDATE login_attempts SET attempt_count = ?, last_attempt_at = ${now()}, locked_until = ? WHERE id = ?`,
      [count, lockedUntil, id],
      { operation: 'LoginLimit.updateAttempt', table: 'login_attempts' }
    );
  },

  /** 创建登录尝试记录 */
  async createAttempt(identifier: string, ipAddress: string): Promise<void> {
    return executeInternal(
      `INSERT INTO login_attempts (identifier, ip_address, attempt_count, last_attempt_at) VALUES (?, ?, 1, ${now()})`,
      [identifier.toLowerCase(), ipAddress],
      { operation: 'LoginLimit.createAttempt', table: 'login_attempts' }
    );
  },

  /** 清除登录尝试记录 */
  async clearAttempts(identifier: string): Promise<void> {
    return executeInternal(
      'DELETE FROM login_attempts WHERE identifier = ?',
      [identifier.toLowerCase()],
      { operation: 'LoginLimit.clearAttempts', table: 'login_attempts' }
    );
  },

  /** 获取锁定账户数量 */
  async getLockedCount(nowExpr: string): Promise<number> {
    const result = await getInternal<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM login_attempts WHERE locked_until > ${nowExpr}`,
      [],
      { operation: 'LoginLimit.getLockedCount', table: 'login_attempts' }
    );
    return result?.cnt || 0;
  },

  /** 获取最近尝试数*/
  async getRecentCount(yesterdayExpr: string): Promise<number> {
    const result = await getInternal<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM login_attempts WHERE last_attempt_at > ${yesterdayExpr}`,
      [],
      { operation: 'LoginLimit.getRecentCount', table: 'login_attempts' }
    );
    return result?.cnt || 0;
  },

  /** 获取尝试次数最多的标识*/
  async getTopIdentifiers(): Promise<QueryResult[]> {
    return queryInternal(
      'SELECT identifier, attempt_count as attempts FROM login_attempts ORDER BY attempt_count DESC LIMIT 10',
      [],
      { operation: 'LoginLimit.getTopIdentifiers', table: 'login_attempts' }
    );
  },
};

// ============================================================================
// 容灾配置业务操作
// ============================================================================

export const FailoverOperations = {
  /** 获取所有启用的容灾配置 */
  async getAllEnabled(): Promise<QueryResult[]> {
    // All databases use 1/0 for integer columns
    const enabledValue = '1';
    return queryInternal(
      `SELECT * FROM failover_configs WHERE enabled = ${enabledValue}`,
      [],
      { operation: 'Failover.getAllEnabled', table: 'failover_configs' }
    );
  },

  /** 根据域名ID获取容灾配置 */
  async getByDomain(domainId: number): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT * FROM failover_configs WHERE domain_id = ?',
      [domainId],
      { operation: 'Failover.getByDomain', table: 'failover_configs' }
    );
  },

  /** 根据ID获取容灾配置 */
  async getById(id: number): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT * FROM failover_configs WHERE id = ?',
      [id],
      { operation: 'Failover.getById', table: 'failover_configs' }
    );
  },

  /** 创建容灾配置 */
  async create(data: Record<string, unknown>): Promise<number> {
    const fields = Object.keys(data);
    const placeholders = fields.map(() => '?').join(', ');
    return insertInternal(
      `INSERT INTO failover_configs (${fields.join(', ')}) VALUES (${placeholders})`,
      Object.values(data),
      { operation: 'Failover.create', table: 'failover_configs' }
    );
  },

  /** 更新容灾配置 */
  async update(id: number, updates: Record<string, unknown>): Promise<void> {
    const fields = Object.keys(updates);
    if (fields.length === 0) return;
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = Object.values(updates);
    return executeInternal(
      `UPDATE failover_configs SET ${setClause} WHERE id = ?`,
      [...values, id],
      { operation: 'Failover.update', table: 'failover_configs' }
    );
  },

  /** 删除容灾配置 */
  async delete(id: number): Promise<void> {
    return executeInternal(
      'DELETE FROM failover_configs WHERE id = ?',
      [id],
      { operation: 'Failover.delete', table: 'failover_configs' }
    );
  },

  /** 获取容灾状*/
  async getStatus(configId: number): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT * FROM failover_status WHERE config_id = ?',
      [configId],
      { operation: 'Failover.getStatus', table: 'failover_status' }
    );
  },

  /** 更新容灾状*/
  async updateStatus(configId: number, updates: Record<string, unknown>): Promise<void> {
    const fields = Object.keys(updates);
    if (fields.length === 0) return;
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = Object.values(updates);
    return executeInternal(
      `UPDATE failover_status SET ${setClause} WHERE config_id = ?`,
      [...values, configId],
      { operation: 'Failover.updateStatus', table: 'failover_status' }
    );
  },

  /** 初始化容灾状*/
  async initStatus(configId: number, primaryIp: string): Promise<void> {
    return executeInternal(
      `INSERT INTO failover_status (config_id, current_ip, is_primary, last_check_time, last_check_result, fail_count, switch_count)
       VALUES (?, ?, 1, ${now()}, 1, 0, 0)`,
      [configId, primaryIp],
      { operation: 'Failover.initStatus', table: 'failover_status' }
    );
  },

  /** 更新检查状(SQLite) */
  async updateCheckStatusSQLite(configId: number, currentIp: string, isPrimary: number, isHealthy: number): Promise<void> {
    return executeInternal(
      `INSERT INTO failover_status (config_id, current_ip, is_primary, last_check_time, last_check_result, switch_count)
       VALUES (?, ?, ?, datetime('now'), ?, 0)
       ON CONFLICT(config_id) DO UPDATE SET
        last_check_time = datetime('now'), last_check_result = excluded.last_check_result`,
      [configId, currentIp, isPrimary, isHealthy],
      { operation: 'Failover.updateCheckStatusSQLite', table: 'failover_status' }
    );
  },

  /** 更新检查状(MySQL) */
  async updateCheckStatusMySQL(configId: number, currentIp: string, isPrimary: number, isHealthy: number): Promise<void> {
    return executeInternal(
      `INSERT INTO failover_status (config_id, current_ip, is_primary, last_check_time, last_check_result, switch_count)
       VALUES (?, ?, ?, NOW(), ?, 0)
       ON DUPLICATE KEY UPDATE
       last_check_time = NOW(), last_check_result = VALUES(last_check_result)`,
      [configId, currentIp, isPrimary, isHealthy],
      { operation: 'Failover.updateCheckStatusMySQL', table: 'failover_status' }
    );
  },

  /** 更新检查状(PostgreSQL) */
  async updateCheckStatusPostgreSQL(configId: number, currentIp: string, isPrimary: number, isHealthy: number): Promise<void> {
    return executeInternal(
      `INSERT INTO failover_status (config_id, current_ip, is_primary, last_check_time, last_check_result, switch_count)
       VALUES ($1, $2, $3, NOW(), $4, 0)
       ON CONFLICT(config_id) DO UPDATE SET
       last_check_time = NOW(), last_check_result = EXCLUDED.last_check_result`,
      [configId, currentIp, isPrimary, isHealthy],
      { operation: 'Failover.updateCheckStatusPostgreSQL', table: 'failover_status' }
    );
  },
};

// ============================================================================
// 服务监控业务操作 (ServiceMonitor)
// ============================================================================

export const ServiceMonitorOperations = {
  /** 获取所有启用的监控 */
  async getAllEnabled(): Promise<QueryResult[]> {
    return queryInternal(
      'SELECT * FROM servicemonitor_monitors WHERE enabled = 1',
      [],
      { operation: 'ServiceMonitor.getAllEnabled', table: 'servicemonitor_monitors' }
    );
  },

  /** 根据用户ID获取监控列表 */
  async getByUser(userId: number): Promise<QueryResult[]> {
    return queryInternal(
      'SELECT * FROM servicemonitor_monitors WHERE user_id = ?',
      [userId],
      { operation: 'ServiceMonitor.getByUser', table: 'servicemonitor_monitors' }
    );
  },

  /** 分页获取用户监控列表（可按类型过滤） */
  async getByUserWithPagination(userId: number, page: number, pageSize: number, type?: string): Promise<{ list: QueryResult[]; total: number }> {
    const offset = (page - 1) * pageSize;

    let countSql = 'SELECT COUNT(*) as count FROM servicemonitor_monitors WHERE user_id = ?';
    const countParams: any[] = [userId];
    if (type) {
      countSql += ' AND type = ?';
      countParams.push(type);
    }
    const countResult = await getInternal<{ count: number }>(
      countSql,
      countParams,
      { operation: 'ServiceMonitor.getByUserWithPagination.count', table: 'servicemonitor_monitors' }
    );
    const total = countResult?.count || 0;

    let listSql = 'SELECT * FROM servicemonitor_monitors WHERE user_id = ?';
    const listParams: any[] = [userId];
    if (type) {
      listSql += ' AND type = ?';
      listParams.push(type);
    }
    listSql += ` ORDER BY created_at DESC LIMIT ${Math.floor(pageSize)} OFFSET ${Math.floor(offset)}`;

    const list = await queryInternal(
      listSql,
      listParams,
      { operation: 'ServiceMonitor.getByUserWithPagination', table: 'servicemonitor_monitors' }
    );
    return { list, total };
  },

  /** 根据ID获取监控 */
  async getById(id: number): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT * FROM servicemonitor_monitors WHERE id = ?',
      [id],
      { operation: 'ServiceMonitor.getById', table: 'servicemonitor_monitors' }
    );
  },

  /** 根据域名ID获取监控 */
  async getByDomain(domainId: number): Promise<QueryResult[]> {
    return queryInternal(
      'SELECT * FROM servicemonitor_monitors WHERE domain_id = ?',
      [domainId],
      { operation: 'ServiceMonitor.getByDomain', table: 'servicemonitor_monitors' }
    );
  },

  /** 根据父级ID获取监控 (endpoint-failover binding) */
  async getByParentId(parentId: number): Promise<QueryResult[]> {
    return queryInternal(
      'SELECT * FROM servicemonitor_monitors WHERE parent_id = ?',
      [parentId],
      { operation: 'ServiceMonitor.getByParentId', table: 'servicemonitor_monitors' }
    );
  },

  /** 创建监控 */
  async create(data: Record<string, unknown>): Promise<number> {
    const fields = Object.keys(data);
    const placeholders = fields.map(() => '?').join(', ');
    return insertInternal(
      `INSERT INTO servicemonitor_monitors (${fields.join(', ')}) VALUES (${placeholders})`,
      Object.values(data),
      { operation: 'ServiceMonitor.create', table: 'servicemonitor_monitors' }
    );
  },

  /** 更新监控 */
  async update(id: number, updates: Record<string, unknown>): Promise<void> {
    const fields = Object.keys(updates);
    if (fields.length === 0) return;
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = Object.values(updates);
    return executeInternal(
      `UPDATE servicemonitor_monitors SET ${setClause} WHERE id = ?`,
      [...values, id],
      { operation: 'ServiceMonitor.update', table: 'servicemonitor_monitors' }
    );
  },

  /** 删除监控 */
  async delete(id: number): Promise<void> {
    return executeInternal(
      'DELETE FROM servicemonitor_monitors WHERE id = ?',
      [id],
      { operation: 'ServiceMonitor.delete', table: 'servicemonitor_monitors' }
    );
  },

  /** 获取监控状态 */
  async getStatus(monitorId: number): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT * FROM servicemonitor_status WHERE monitor_id = ?',
      [monitorId],
      { operation: 'ServiceMonitor.getStatus', table: 'servicemonitor_status' }
    );
  },

  /** 更新监控状态 (UPSERT) */
  async updateStatus(monitorId: number, updates: Record<string, unknown>): Promise<void> {
    const fields = Object.keys(updates);
    if (fields.length === 0) return;
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = Object.values(updates);
    return executeInternal(
      `UPDATE servicemonitor_status SET ${setClause} WHERE monitor_id = ?`,
      [...values, monitorId],
      { operation: 'ServiceMonitor.updateStatus', table: 'servicemonitor_status' }
    );
  },

  /** 初始化监控状态 */
  async initStatus(monitorId: number): Promise<void> {
    return executeInternal(
      `INSERT INTO servicemonitor_status (monitor_id, status, last_check_at)
       VALUES (?, 'unknown', ${now()})`,
      [monitorId],
      { operation: 'ServiceMonitor.initStatus', table: 'servicemonitor_status' }
    );
  },

  /** 更新状态并记录检查结果(SQLite) */
  async updateCheckStatusSQLite(monitorId: number, status: string, responseTime: number | null, error: string | null): Promise<void> {
    const errorField = error ? `, last_error = '${error.replace(/'/g, "''")}'` : '';
    const responseTimeField = responseTime !== null ? `, last_response_time = ${responseTime}` : '';
    return executeInternal(
      `INSERT INTO servicemonitor_status (monitor_id, status, last_check_at, last_response_time, last_error${error ? ', last_failure_at' : ', last_success_at'})
       VALUES (?, ?, datetime('now'), ?, ?${error ? `, datetime('now')` : `, datetime('now')`})
       ON CONFLICT(monitor_id) DO UPDATE SET
        status = excluded.status, last_check_at = datetime('now'), last_response_time = excluded.last_response_time${error ? `, last_error = '${error.replace(/'/g, "''")}', last_failure_at = datetime('now')` : `, last_error = NULL, last_success_at = datetime('now')`}`,
      [monitorId, status, responseTime, responseTime],
      { operation: 'ServiceMonitor.updateCheckStatusSQLite', table: 'servicemonitor_status' }
    );
  },

  /** 更新状态并记录检查结果(MySQL) */
  async updateCheckStatusMySQL(monitorId: number, status: string, responseTime: number | null, error: string | null): Promise<void> {
    const errorField = error ? `, last_error = '${error.replace(/'/g, "\\'")}'` : '';
    return executeInternal(
      `INSERT INTO servicemonitor_status (monitor_id, status, last_check_at, last_response_time, last_error)
       VALUES (?, ?, NOW(), ?, ?)
       ON DUPLICATE KEY UPDATE
        status = VALUES(status), last_check_at = NOW(), last_response_time = VALUES(last_response_time),
        last_error = VALUES(last_error)${error ? `, last_failure_at = NOW()` : `, last_success_at = NOW()`}`,
      [monitorId, status, responseTime, error],
      { operation: 'ServiceMonitor.updateCheckStatusMySQL', table: 'servicemonitor_status' }
    );
  },

  /** 更新状态并记录检查结果(PostgreSQL) */
  async updateCheckStatusPostgreSQL(monitorId: number, status: string, responseTime: number | null, error: string | null): Promise<void> {
    return executeInternal(
      `INSERT INTO servicemonitor_status (monitor_id, status, last_check_at, last_response_time, last_error)
       VALUES ($1, $2, NOW(), $3, $4)
       ON CONFLICT(monitor_id) DO UPDATE SET
        status = EXCLUDED.status, last_check_at = NOW(), last_response_time = EXCLUDED.last_response_time,
        last_error = EXCLUDED.last_error${error ? `, last_failure_at = NOW()` : `, last_success_at = NOW()`}`,
      [monitorId, status, responseTime, error],
      { operation: 'ServiceMonitor.updateCheckStatusPostgreSQL', table: 'servicemonitor_status' }
    );
  },
};

// ============================================================================
// 审计日志导出业务操作
// ============================================================================

export const AuditExportOperations = {
  /** 获取审计日志总数 */
  async getCount(where: string, params: unknown[]): Promise<number> {
    const result = await getInternal<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM operation_logs l WHERE ${where}`,
      params,
      { operation: 'AuditExport.getCount', table: 'operation_logs' }
    );
    return result?.cnt || 0;
  },

  /** 获取审计日志列表 */
  async getLogs(where: string, params: unknown[], pageSize: number, offset: number): Promise<QueryResult[]> {
    const dbType = getDbType();
    // Use CASE WHEN to display 'Root' for user_id = 0
    const listSql = dbType === 'postgresql'
      ? `SELECT l.*,
          CASE WHEN l.user_id = 0 THEN 'Root' ELSE u.username END as username,
          CASE WHEN l.user_id = 0 THEN '后端' ELSE u.nickname END as nickname
         FROM operation_logs l
         LEFT JOIN users u ON u.id = l.user_id WHERE ${where} ORDER BY l.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
      : `SELECT l.*,
          CASE WHEN l.user_id = 0 THEN 'Root' ELSE u.username END as username,
          CASE WHEN l.user_id = 0 THEN '后端' ELSE u.nickname END as nickname
         FROM operation_logs l
         LEFT JOIN users u ON u.id = l.user_id WHERE ${where} ORDER BY l.id DESC LIMIT ? OFFSET ?`;
    const finalSql = dbType === 'mysql'
      ? listSql.replace('LIMIT ? OFFSET ?', `LIMIT ${pageSize} OFFSET ${offset}`)
      : listSql;
    const finalParams = dbType === 'mysql' ? params : [...params, pageSize, offset];
    return queryInternal(finalSql, finalParams, { operation: 'AuditExport.getLogs', table: 'operation_logs' });
  },

  /** 检测异- 删除操作 */
  async getDeleteCount(userId: number, timeWindow: string): Promise<number> {
    const result = await getInternal<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM operation_logs WHERE user_id = ? AND action LIKE \'%delete%\' AND created_at > ?',
      [userId, timeWindow],
      { operation: 'AuditExport.getDeleteCount', table: 'operation_logs' }
    );
    return result?.cnt || 0;
  },

  /** 检测异- 创建操作 */
  async getCreateCount(userId: number, timeWindow: string): Promise<number> {
    const result = await getInternal<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM operation_logs WHERE user_id = ? AND action LIKE \'%create%\' AND created_at > ?',
      [userId, timeWindow],
      { operation: 'AuditExport.getCreateCount', table: 'operation_logs' }
    );
    return result?.cnt || 0;
  },

  /** 检测异- 域名数量 */
  async getDomainCount(userId: number, timeWindow: string): Promise<number> {
    const result = await getInternal<{ cnt: number }>(
      'SELECT COUNT(DISTINCT domain) as cnt FROM operation_logs WHERE user_id = ? AND created_at > ?',
      [userId, timeWindow],
      { operation: 'AuditExport.getDomainCount', table: 'operation_logs' }
    );
    return result?.cnt || 0;
  },

  /** 获取用户操作统计 */
  async getUserActionStats(userId: number, startDate: string): Promise<QueryResult[]> {
    return queryInternal(
      'SELECT action, COUNT(*) as count FROM operation_logs WHERE user_id = ? AND created_at > ? GROUP BY action ORDER BY count DESC',
      [userId, startDate],
      { operation: 'AuditExport.getUserActionStats', table: 'operation_logs' }
    );
  },

  /** 获取操作时间分布 (SQLite) */
  async getTimeDistributionSQLite(userId: number, startDate: string): Promise<QueryResult[]> {
    return queryInternal(
      `SELECT STRFTIME('%H', created_at) as hour, COUNT(*) as count FROM operation_logs
       WHERE user_id = ? AND created_at > ? GROUP BY STRFTIME('%H', created_at) ORDER BY hour`,
      [userId, startDate],
      { operation: 'AuditExport.getTimeDistributionSQLite', table: 'operation_logs' }
    );
  },

  /** 获取操作时间分布 (PostgreSQL) */
  async getTimeDistributionPostgreSQL(userId: number, startDate: string): Promise<QueryResult[]> {
    return queryInternal(
      `SELECT EXTRACT(HOUR FROM created_at) as hour, COUNT(*) as count FROM operation_logs
       WHERE user_id = $1 AND created_at > $2 GROUP BY EXTRACT(HOUR FROM created_at) ORDER BY hour`,
      [userId, startDate],
      { operation: 'AuditExport.getTimeDistributionPostgreSQL', table: 'operation_logs' }
    );
  },
};

// ============================================================================
// TOTP 2FA 业务操作
// ============================================================================

export const TOTPOperations = {
  /** 获取 TOTP 配置 */
  async getByUser(userId: number): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT enabled, secret, backup_codes FROM user_2fa WHERE user_id = ? AND type = ?',
      [userId, 'totp'],
      { operation: 'TOTP.getByUser', table: 'user_2fa' }
    );
  },

  /** 启用 TOTP (SQLite) */
  async enableSQLite(userId: number, secret: string, encryptedCodes: string): Promise<void> {
    return executeInternal(
      `INSERT INTO user_2fa (user_id, type, secret, backup_codes, enabled, created_at)
       VALUES (?, ?, ?, ?, TRUE, datetime('now'))
       ON CONFLICT(user_id, type) DO UPDATE SET
        secret = excluded.secret, backup_codes = excluded.backup_codes,
        enabled = TRUE, updated_at = datetime('now')`,
      [userId, 'totp', secret, encryptedCodes],
      { operation: 'TOTP.enableSQLite', table: 'user_2fa' }
    );
  },

  /** 启用 TOTP (MySQL) */
  async enableMySQL(userId: number, secret: string, encryptedCodes: string): Promise<void> {
    return executeInternal(
      `INSERT INTO user_2fa (user_id, type, secret, backup_codes, enabled, created_at)
       VALUES (?, ?, ?, ?, TRUE, NOW())
       ON DUPLICATE KEY UPDATE
       secret = VALUES(secret), backup_codes = VALUES(backup_codes),
       enabled = TRUE, updated_at = NOW()`,
      [userId, 'totp', secret, encryptedCodes],
      { operation: 'TOTP.enableMySQL', table: 'user_2fa' }
    );
  },

  /** 启用 TOTP (PostgreSQL) */
  async enablePostgreSQL(userId: number, secret: string, encryptedCodes: string): Promise<void> {
    return executeInternal(
      `INSERT INTO user_2fa (user_id, type, secret, backup_codes, enabled, created_at)
       VALUES ($1, $2, $3, $4, 1, NOW())
       ON CONFLICT(user_id, type) DO UPDATE SET
       secret = EXCLUDED.secret, backup_codes = EXCLUDED.backup_codes,
       enabled = 1, updated_at = NOW()`,
      [userId, 'totp', secret, encryptedCodes],
      { operation: 'TOTP.enablePostgreSQL', table: 'user_2fa' }
    );
  },

  /** 禁用 TOTP */
  async disable(userId: number, enabledValue: number | boolean): Promise<void> {
    return executeInternal(
      'UPDATE user_2fa SET enabled = ? WHERE user_id = ? AND type = ?',
      [enabledValue, userId, 'totp'],
      { operation: 'TOTP.disable', table: 'user_2fa' }
    );
  },

  /** 验证备用*/
  async verifyBackupCode(userId: number, enabledValue: number | boolean): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT backup_codes FROM user_2fa WHERE user_id = ? AND type = ? AND enabled = ?',
      [userId, 'totp', enabledValue],
      { operation: 'TOTP.verifyBackupCode', table: 'user_2fa' }
    );
  },

  /** 更新备用*/
  async updateBackupCodes(userId: number, codes: string): Promise<void> {
    return executeInternal(
      'UPDATE user_2fa SET backup_codes = ? WHERE user_id = ? AND type = ?',
      [codes, userId, 'totp'],
      { operation: 'TOTP.updateBackupCodes', table: 'user_2fa' }
    );
  },
};

// ============================================================================
// WebAuthn 业务操作
// ============================================================================

export const WebAuthnOperations = {
  /** 获取用户WebAuthn 凭证 */
  async getByUser(userId: number): Promise<QueryResult[]> {
    return queryInternal(
      'SELECT * FROM webauthn_credentials WHERE user_id = ?',
      [userId],
      { operation: 'WebAuthn.getByUser', table: 'webauthn_credentials' }
    );
  },

  /** 添加 WebAuthn 凭证 */
  async add(cred: { id: string; user_id: number; public_key: string; counter: number; device_type: string; backed_up: number; transports: string; name: string }): Promise<void> {
    return executeInternal(
      'INSERT INTO webauthn_credentials (id, user_id, public_key, counter, device_type, backed_up, transports, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [cred.id, cred.user_id, cred.public_key, cred.counter, cred.device_type, cred.backed_up, cred.transports, cred.name],
      { operation: 'WebAuthn.add', table: 'webauthn_credentials' }
    );
  },

  /** 检查用户是否有 WebAuthn 配置 */
  async exists(userId: number): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT * FROM user_2fa WHERE user_id = ? AND type = ?',
      [userId, 'webauthn'],
      { operation: 'WebAuthn.exists', table: 'user_2fa' }
    );
  },

  /** 创建 WebAuthn 配置 */
  async createConfig(userId: number): Promise<void> {
    const dbType = getDbType();
    // PostgreSQL 使用 true/false，SQLite/MySQL 使用 1/0
    const enabledValue = dbType === 'postgresql' ? true : 1;
    return executeInternal(
      'INSERT INTO user_2fa (user_id, type, secret, enabled) VALUES (?, ?, ?, ?)',
      [userId, 'webauthn', 'webauthn', enabledValue],
      { operation: 'WebAuthn.createConfig', table: 'user_2fa' }
    );
  },

  /** 启用 WebAuthn */
  async enable(userId: number): Promise<void> {
    const dbType = getDbType();
    // PostgreSQL 使用 true/false，SQLite/MySQL 使用 1/0
    const enabledValue = dbType === 'postgresql' ? true : 1;
    return executeInternal(
      'UPDATE user_2fa SET enabled = ? WHERE user_id = ? AND type = ?',
      [enabledValue, userId, 'webauthn'],
      { operation: 'WebAuthn.enable', table: 'user_2fa' }
    );
  },

  /** 更新凭证计数*/
  async updateCounter(id: string, counter: number): Promise<void> {
    return executeInternal(
      `UPDATE webauthn_credentials SET counter = ?, last_used_at = ${now()} WHERE id = ?`,
      [counter, id],
      { operation: 'WebAuthn.updateCounter', table: 'webauthn_credentials' }
    );
  },

  /** 删除凭证 */
  async delete(userId: number, id: string): Promise<void> {
    return executeInternal(
      'DELETE FROM webauthn_credentials WHERE user_id = ? AND id = ?',
      [userId, id],
      { operation: 'WebAuthn.delete', table: 'webauthn_credentials' }
    );
  },

  /** 禁用 WebAuthn */
  async disable(userId: number): Promise<void> {
    return executeInternal(
      'UPDATE user_2fa SET enabled = ? WHERE user_id = ? AND type = ?',
      [0, userId, 'webauthn'],
      { operation: 'WebAuthn.disable', table: 'user_2fa' }
    );
  },
};

// ============================================================================
// SMTP 配置业务操作
// ============================================================================

export const SmtpOperations = {
  /** 获取 SMTP 配置 */
  async getConfig(): Promise<QueryResult | undefined> {
    return getInternal(
      "SELECT value FROM system_settings WHERE key = 'smtp_config'",
      [],
      { operation: 'Smtp.getConfig', table: 'system_settings' }
    );
  },

  /** 更新 SMTP 配置 (MySQL) */
  async updateConfigMySQL(configJson: string): Promise<void> {
    return executeInternal(
      `INSERT INTO system_settings (\`key\`, \`value\`, updated_at) VALUES (?, ?, ${now()})
       ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), updated_at = ${now()}`,
      ['smtp_config', configJson],
      { operation: 'Smtp.updateConfigMySQL', table: 'system_settings' }
    );
  },

  /** 更新 SMTP 配置 (SQLite) */
  async updateConfigSQLite(configJson: string): Promise<void> {
    return executeInternal(
      `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ${now()})
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = ${now()}`,
      ['smtp_config', configJson],
      { operation: 'Smtp.updateConfigSQLite', table: 'system_settings' }
    );
  },

  /** 更新 SMTP 配置 (PostgreSQL) */
  async updateConfigPostgreSQL(configJson: string): Promise<void> {
    return executeInternal(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, ${now()})
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = ${now()}`,
      ['smtp_config', configJson],
      { operation: 'Smtp.updateConfigPostgreSQL', table: 'system_settings' }
    );
  },
};

// ============================================================================
// WHOIS 业务操作
// ============================================================================

export const WhoisOperations = {
  /** 获取所有域*/
  async getAllDomains(): Promise<QueryResult[]> {
    return queryInternal(
      'SELECT id, name, account_id FROM domains',
      [],
      { operation: 'Whois.getAllDomains', table: 'domains' }
    );
  },

  /** 更新域名过期时间 */
  async updateExpiry(domainId: number, expiresAt: string, apexExpiresAt?: string | null, whoisStatus?: string | null): Promise<void> {
    if (apexExpiresAt !== undefined && whoisStatus !== undefined) {
      return executeInternal(
        'UPDATE domains SET expires_at = ?, apex_expires_at = ?, whois_status = ? WHERE id = ?',
        [expiresAt, apexExpiresAt, whoisStatus, domainId],
        { operation: 'Whois.updateExpiry', table: 'domains' }
      );
    } else if (apexExpiresAt !== undefined) {
      return executeInternal(
        'UPDATE domains SET expires_at = ?, apex_expires_at = ? WHERE id = ?',
        [expiresAt, apexExpiresAt, domainId],
        { operation: 'Whois.updateExpiry', table: 'domains' }
      );
    } else if (whoisStatus !== undefined) {
      return executeInternal(
        'UPDATE domains SET expires_at = ?, whois_status = ? WHERE id = ?',
        [expiresAt, whoisStatus, domainId],
        { operation: 'Whois.updateExpiry', table: 'domains' }
      );
    }
    return executeInternal(
      'UPDATE domains SET expires_at = ? WHERE id = ?',
      [expiresAt, domainId],
      { operation: 'Whois.updateExpiry', table: 'domains' }
    );
  },

  /** 获取域名过期通知设置 */
  async getNotificationSetting(): Promise<QueryResult | undefined> {
    return getInternal(
      "SELECT value FROM system_settings WHERE key = 'domain_expiry_notification'",
      [],
      { operation: 'Whois.getNotificationSetting', table: 'system_settings' }
    );
  },

  /** 获取域名过期阈*/
  async getExpiryDays(): Promise<QueryResult | undefined> {
    return getInternal(
      "SELECT value FROM system_settings WHERE key = 'domain_expiry_days'",
      [],
      { operation: 'Whois.getExpiryDays', table: 'system_settings' }
    );
  },

  /** 根据ID获取域名 */
  async getDomainById(id: number): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT id, name, account_id FROM domains WHERE id = ?',
      [id],
      { operation: 'Whois.getDomainById', table: 'domains' }
    );
  },

  /** 确保 whois_cache 表存*/
  async ensureWhoisCacheTable(): Promise<void> {
    const dbType = db.type;

    try {
      if (dbType === 'sqlite') {
        await executeInternal(`
          CREATE TABLE IF NOT EXISTS whois_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            domain_name VARCHAR(255) NOT NULL UNIQUE,
            whois_data TEXT,
            status TEXT,
            cached_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME
          )
        `, [], { operation: 'Whois.ensureWhoisCacheTable', table: 'whois_cache' });
      } else if (dbType === 'mysql') {
        await executeInternal(`
          CREATE TABLE IF NOT EXISTS whois_cache (
            id INT AUTO_INCREMENT PRIMARY KEY,
            domain_name VARCHAR(255) NOT NULL UNIQUE,
            whois_data JSON,
            status VARCHAR(50),
            cached_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `, [], { operation: 'Whois.ensureWhoisCacheTable', table: 'whois_cache' });
      } else if (dbType === 'postgresql') {
        await executeInternal(`
          CREATE TABLE IF NOT EXISTS whois_cache (
            id SERIAL PRIMARY KEY,
            domain_name VARCHAR(255) NOT NULL UNIQUE,
            whois_data JSONB,
            status VARCHAR(50),
            cached_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP
          )
        `, [], { operation: 'Whois.ensureWhoisCacheTable', table: 'whois_cache' });
      }
    } catch (error) {
      const errorMsg = (error as Error).message || '';
      if (!errorMsg.includes('already exists') && !errorMsg.includes('ER_TABLE_EXISTS_ERROR')) {
        log.warn( 'Failed to create whois_cache table', { error: errorMsg, dbType });
      }
    }
  },

  /** 从数据库获取缓存WHOIS 结果 */
  async getCachedWhois(domain: string, cacheTtlSeconds: number): Promise<QueryResult | undefined> {
    const dbType = getDbType();

    if (dbType === 'postgresql') {
      return await getInternal(
        `SELECT whois_data, status, cached_at, expires_at FROM whois_cache WHERE domain_name = $1 AND
         cached_at > NOW() - ($2 || ' seconds')::interval`,
        [domain, cacheTtlSeconds],
        { operation: 'Whois.getCachedWhois', table: 'whois_cache' }
      );
    } else if (dbType === 'mysql') {
      return await getInternal(
        `SELECT whois_data, status, cached_at, expires_at FROM whois_cache WHERE domain_name = ? AND
         cached_at > DATE_SUB(NOW(), INTERVAL ? SECOND)`,
        [domain, cacheTtlSeconds],
        { operation: 'Whois.getCachedWhois', table: 'whois_cache' }
      );
    } else {
      return await getInternal(
        `SELECT whois_data, status, cached_at, expires_at FROM whois_cache WHERE domain_name = ? AND
         cached_at > datetime('now', '-' || ? || ' seconds')`,
        [domain, cacheTtlSeconds],
        { operation: 'Whois.getCachedWhois', table: 'whois_cache' }
      );
    }
  },

  /** WHOIS 结果缓存到数据库 */
  async setCachedWhois(
    domain: string,
    expiryDate: string | null,
    apexExpiryDate: string | null,
    registrar: string | null,
    nameServers: string,
    rawData: string,
    status: string | null = null
  ): Promise<void> {
    const whoisData = JSON.stringify({ expiryDate, apexExpiryDate, registrar, nameServers, raw: rawData });
    const dbType = getDbType();

    if (dbType === 'postgresql') {
      await executeInternal(
        `INSERT INTO whois_cache (domain_name, whois_data, status, cached_at)
         VALUES ($1, $2::jsonb, $3, NOW())
         ON CONFLICT(domain_name) DO UPDATE SET
           whois_data = EXCLUDED.whois_data,
           status = EXCLUDED.status,
           cached_at = NOW()`,
        [domain, whoisData, status],
        { operation: 'Whois.setCachedWhois', table: 'whois_cache' }
      );
    } else if (dbType === 'mysql') {
      await executeInternal(
        `INSERT INTO whois_cache (domain_name, whois_data, status, cached_at)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           whois_data = VALUES(whois_data),
           status = VALUES(status),
           cached_at = NOW()`,
        [domain, whoisData, status],
        { operation: 'Whois.setCachedWhois', table: 'whois_cache' }
      );
    } else {
      await executeInternal(
        `INSERT INTO whois_cache (domain_name, whois_data, status, cached_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(domain_name) DO UPDATE SET
           whois_data = excluded.whois_data,
           status = excluded.status,
           cached_at = CURRENT_TIMESTAMP`,
        [domain, whoisData, status],
        { operation: 'Whois.setCachedWhois', table: 'whois_cache' }
      );
    }

    // 只保留最近 100 条缓存，防止 whois_cache 表无限膨胀
    await trimWhoisCache(dbType);
  },
};

/** 将 whois_cache 裁剪到最多 100 条 */
async function trimWhoisCache(dbType: string): Promise<void> {
  try {
    const keepSql = `SELECT domain_name FROM whois_cache ORDER BY cached_at DESC LIMIT 100`;
    if (dbType === 'mysql') {
      await executeInternal(
        `DELETE FROM whois_cache WHERE domain_name NOT IN (
          SELECT domain_name FROM (${keepSql}) AS keep
        )`,
        [],
        { operation: 'Whois.trimWhoisCache', table: 'whois_cache' }
      );
    } else {
      await executeInternal(
        `DELETE FROM whois_cache WHERE domain_name NOT IN (${keepSql})`,
        [],
        { operation: 'Whois.trimWhoisCache', table: 'whois_cache' }
      );
    }
  } catch (e) {
    // 裁剪失败不影响主流程，仅记录
  }
}

// ============================================================================
// Renewable Domain Operations - 续期域名操作
// ============================================================================

export const RenewableDomainOperations = {
  /** 根据 ID 获取续期域名 */
  async getById(id: number): Promise<any | null> {
    return await getInternal(
      'SELECT * FROM renewable_domains WHERE id = ?',
      [id],
      { operation: 'RenewableDomain.getById', table: 'renewable_domains' }
    );
  },

  /** 获取所有续期域名（包括启用和禁用，但过滤掉已禁用账号的域名*/
  async getAll(): Promise<any[]> {
    const enabledValue = '1';
    const builder = RenewableDomainQueryBuilder.all(enabledValue);
    const { sql, params } = builder.build();

    return await queryInternal(sql, params, { operation: 'RenewableDomain.getAll', table: 'renewable_domains' });
  },

  /** 分页获取续期域名（支持高级筛选） */
  async getAllWithPagination(options: {
    page: number;
    pageSize: number;
    keyword?: string;
    accountId?: number;
    status?: 'enabled' | 'disabled' | 'all';
  }): Promise<{ list: any[]; total: number }> {
    const { page, pageSize, keyword, accountId, status } = options;
    const offset = (page - 1) * pageSize;
    const keywordParam = keyword ? `%${keyword}%` : '';

    // Count query
    const countBuilder = new RenewableDomainQueryBuilder()
      .joinAccounts()
      .whereAccountEnabled();
    if (keyword) {
      countBuilder.where('(rd.full_domain LIKE ? OR rd.domain_name LIKE ?)', keywordParam, keywordParam);
    }
    if (accountId) {
      countBuilder.whereAccountId(accountId);
    }
    if (status === 'enabled') {
      countBuilder.whereRenewableEnabled();
    } else if (status === 'disabled') {
      countBuilder.where('rd.enabled = 0');
    }
    const countQuery = countBuilder.build();
    const countResult = await getInternal<{ count: number }>(
      `SELECT COUNT(*) as count FROM (${countQuery.sql}) sub`,
      countQuery.params,
      { operation: 'RenewableDomain.getAllWithPagination.count', table: 'renewable_domains' }
    );
    const total = countResult?.count || 0;

    // List query
    const listBuilder = new RenewableDomainQueryBuilder()
      .select('rd.*, da.name as account_name, da.type as provider_type')
      .joinAccounts()
      .whereAccountEnabled();
    if (keyword) {
      listBuilder.where('(rd.full_domain LIKE ? OR rd.domain_name LIKE ?)', keywordParam, keywordParam);
    }
    if (accountId) {
      listBuilder.whereAccountId(accountId);
    }
    if (status === 'enabled') {
      listBuilder.whereRenewableEnabled();
    } else if (status === 'disabled') {
      listBuilder.where('rd.enabled = 0');
    }
    listBuilder.orderByColumn('rd.full_domain', 'ASC');
    const listQuery = listBuilder.build();
    const listSql = `${listQuery.sql} LIMIT ${Math.floor(pageSize)} OFFSET ${Math.floor(offset)}`;

    const list = await queryInternal(listSql, listQuery.params, {
      operation: 'RenewableDomain.getAllWithPagination', table: 'renewable_domains'
    });

    return { list, total };
  },

  /** 获取所有启用的续期域名（过滤掉已禁用账号的域名*/
  async getAllEnabled(): Promise<any[]> {
    const enabledValue = '1';

    const builder = RenewableDomainQueryBuilder.allEnabled(enabledValue);
    const { sql, params } = builder.build();

    return await queryInternal(sql, params, { operation: 'RenewableDomain.getAllEnabled', table: 'renewable_domains' });
  },

  /** 根据账号 ID 获取续期域名列表 */
  async getByAccountId(accountId: number): Promise<any[]> {
    const builder = RenewableDomainQueryBuilder.byAccountId(accountId);
    const { sql, params } = builder.build();

    return await queryInternal(sql, params, { operation: 'RenewableDomain.getByAccountId', table: 'renewable_domains' });
  },

  /** 根据提供商类型获取续期域名列表（过滤掉已禁用账号的域名） */
  async getByProviderType(providerType: string): Promise<any[]> {
    const enabledValue = '1';

    const builder = RenewableDomainQueryBuilder.byProviderType(providerType, enabledValue);
    const { sql, params } = builder.build();

    return await queryInternal(sql, params, { operation: 'RenewableDomain.getByProviderType', table: 'renewable_domains' });
  },

  /** 添加续期域名 */
  async add(data: {
    account_id: number;
    provider_type: string;
    domain_name: string;
    third_id: string;
    full_domain: string;
    expires_at?: string;
    never_expires?: boolean;
    remark?: string;
    adapter_data?: string | null;
  }): Promise<number> {
    const dbType = getDbType();
    const enabledValue = dbType === 'postgresql' ? true : 1;
    const neverExpiresValue = dbType === 'postgresql' ? (data.never_expires ? true : false) : (data.never_expires ? 1 : 0);

    const result = await insertInternal(
      'INSERT INTO renewable_domains (account_id, provider_type, domain_name, third_id, full_domain, expires_at, never_expires, enabled, remark, adapter_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        data.account_id,
        data.provider_type,
        data.domain_name,
        data.third_id,
        data.full_domain,
        data.expires_at || null,
        neverExpiresValue,
        enabledValue,  // enabled (always enable new domains)
        data.remark || '',
        data.adapter_data ?? null,
      ],
      { operation: 'RenewableDomain.add', table: 'renewable_domains' }
    );
    return result;
  },

  /** 批量添加续期域名 */
  async addBatch(domains: Array<{
    account_id: number;
    provider_type: string;
    domain_name: string;
    third_id: string;
    full_domain: string;
    expires_at?: string;
    never_expires?: boolean;
    remark?: string;
  }>): Promise<number> {
    let addedCount = 0;
    for (const domain of domains) {
      try {
        await this.add(domain);
        addedCount++;
      } catch (error) {
        // 跳过重复的域名（UNIQUE 约束
        log.warn('Skip duplicate domain', {
          domain: domain.full_domain,
          error: (error as Error).message
        });
      }
    }
    return addedCount;
  },

  /** 更新续期域名的到期时*/
  async updateExpiry(id: number, expiresAt: string | null): Promise<void> {
    await executeInternal(
      'UPDATE renewable_domains SET expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [expiresAt, id],
      { operation: 'RenewableDomain.updateExpiry', table: 'renewable_domains' }
    );
  },

  /** 更新续期域名的到期时间（别名*/
  async updateExpiresAt(id: number, expiresAt: string): Promise<void> {
    await this.updateExpiry(id, expiresAt);
  },

  /** 标记为已续期 */
  async markAsRenewed(id: number, newExpiresAt: string): Promise<void> {
    await executeInternal(
      'UPDATE renewable_domains SET expires_at = ?, last_renewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newExpiresAt, id],
      { operation: 'RenewableDomain.markAsRenewed', table: 'renewable_domains' }
    );
  },

  /** 删除续期域名 */
  async delete(id: number): Promise<void> {
    await executeInternal(
      'DELETE FROM renewable_domains WHERE id = ?',
      [id],
      { operation: 'RenewableDomain.delete', table: 'renewable_domains' }
    );
  },

  /** 禁用/启用续期域名 */
  async toggleEnabled(id: number, enabled: boolean): Promise<void> {
    await executeInternal(
      'UPDATE renewable_domains SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [enabled ? 1 : 0, id],
      { operation: 'RenewableDomain.toggleEnabled', table: 'renewable_domains' }
    );
  },

  /** 检查域名是否已添加 */
  async exists(accountId: number, thirdId: string): Promise<boolean> {
    const result = await getInternal(
      'SELECT COUNT(*) as count FROM renewable_domains WHERE account_id = ? AND third_id = ?',
      [accountId, thirdId],
      { operation: 'RenewableDomain.exists', table: 'renewable_domains' }
    );
    return (result as any)?.count > 0;
  },

  /** 获取各类状态的域名计数（活跃/即将到期/已过期） */
  async getStatusCounts(): Promise<{ active: number; expiring: number; expired: number }> {
    const dbType = getDbType();
    let nowSql: string;
    let addDaysSql: string;
    if (dbType === 'sqlite') {
      nowSql = "datetime('now')";
      addDaysSql = "datetime('now', '+60 days')";
    } else if (dbType === 'postgresql') {
      nowSql = 'NOW()';
      addDaysSql = "NOW() + INTERVAL '60 days'";
    } else {
      nowSql = 'NOW()';
      addDaysSql = 'DATE_ADD(NOW(), INTERVAL 60 DAY)';
    }

    const sql = `SELECT
      SUM(CASE WHEN rd.expires_at IS NULL OR rd.expires_at > ${addDaysSql} THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN rd.expires_at IS NOT NULL AND rd.expires_at <= ${addDaysSql} AND rd.expires_at >= ${nowSql} THEN 1 ELSE 0 END) as expiring,
      SUM(CASE WHEN rd.expires_at IS NOT NULL AND rd.expires_at < ${nowSql} THEN 1 ELSE 0 END) as expired
    FROM renewable_domains rd
    INNER JOIN dns_accounts da ON rd.account_id = da.id
    WHERE da.enabled = 1`;

    const result = await getInternal<{ active: number; expiring: number; expired: number }>(sql, [], {
      operation: 'RenewableDomain.getStatusCounts', table: 'renewable_domains'
    });
    return {
      active: result?.active || 0,
      expiring: result?.expiring || 0,
      expired: result?.expired || 0,
    };
  },
};

// ============================================================================
// 审计规则业务操作
// ============================================================================

export const AuditRulesOperations = {
  /** 获取审计规则配置 */
  async getConfig(): Promise<QueryResult | undefined> {
    return getInternal(
      "SELECT value FROM system_settings WHERE key = 'audit_rules'",
      [],
      { operation: 'AuditRules.getConfig', table: 'system_settings' }
    );
  },

  /** 获取用户*/
  async getUsername(userId: number): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT username FROM users WHERE id = ?',
      [userId],
      { operation: 'AuditRules.getUsername', table: 'users' }
    );
  },

  /** 获取最近删除操作数(SQLite) */
  async getRecentDeletionsSQLite(userId: number): Promise<QueryResult | undefined> {
    return getInternal(
      `SELECT COUNT(*) as count FROM operation_logs WHERE user_id = ? AND action IN ('delete_record', 'delete_domain')
       AND created_at >= datetime('now', '-1 hour')`,
      [userId],
      { operation: 'AuditRules.getRecentDeletionsSQLite', table: 'operation_logs' }
    );
  },

  /** 获取最近删除操作数(MySQL) */
  async getRecentDeletionsMySQL(userId: number): Promise<QueryResult | undefined> {
    return getInternal(
      `SELECT COUNT(*) as count FROM operation_logs WHERE user_id = ? AND action IN ('delete_record', 'delete_domain')
       AND created_at >= NOW() - INTERVAL 1 HOUR`,
      [userId],
      { operation: 'AuditRules.getRecentDeletionsMySQL', table: 'operation_logs' }
    );
  },

  /** 获取最近删除操作数(PostgreSQL) */
  async getRecentDeletionsPostgreSQL(userId: number): Promise<QueryResult | undefined> {
    return getInternal(
      `SELECT COUNT(*) as count FROM operation_logs WHERE user_id = $1 AND action IN ('delete_record', 'delete_domain')
       AND created_at >= NOW() - INTERVAL '1 hour'`,
      [userId],
      { operation: 'AuditRules.getRecentDeletionsPostgreSQL', table: 'operation_logs' }
    );
  },
};

// ============================================================================
// 审计日志记录业务操作
// ============================================================================

export const AuditLogOperations = {
  /** 记录审计日志 */
  async log(userId: number, action: string, domain: string, data: string): Promise<void> {
    return executeInternal(
      'INSERT INTO operation_logs (user_id, action, domain, data) VALUES (?, ?, ?, ?)',
      [userId, action, domain, data],
      { operation: 'AuditLog.log', table: 'operation_logs' }
    );
  },
};

// ============================================================================
// NS 监测业务操作（新架构：用户级偏好 + 域名监测列表
// ============================================================================

export const NSMonitorOperations = {
  // ========== 用户偏好设置 ==========

  /** 获取用户NS 监测偏好设置 */
  async getUserPrefs(userId: number): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT * FROM user_ns_monitor_prefs WHERE user_id = ?',
      [userId],
      { operation: 'NSMonitor.getUserPrefs', table: 'user_ns_monitor_prefs' }
    );
  },

  /** 创建用户NS 监测偏好设置 */
  async createUserPrefs(userId: number, data: Record<string, unknown>): Promise<number> {
    const fields = ['user_id', ...Object.keys(data)];
    const placeholders = fields.map(() => '?').join(', ');
    const values = [userId, ...Object.values(data)];
    return insertInternal(
      `INSERT INTO user_ns_monitor_prefs (${fields.join(', ')}) VALUES (${placeholders})`,
      values,
      { operation: 'NSMonitor.createUserPrefs', table: 'user_ns_monitor_prefs' }
    );
  },

  /** 更新用户NS 监测偏好设置 */
  async updateUserPrefs(userId: number, updates: Record<string, unknown>): Promise<void> {
    const fields = Object.keys(updates);
    if (fields.length === 0) return;
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = Object.values(updates);
    return executeInternal(
      `UPDATE user_ns_monitor_prefs SET ${setClause} WHERE user_id = ?`,
      [...values, userId],
      { operation: 'NSMonitor.updateUserPrefs', table: 'user_ns_monitor_prefs' }
    );
  },

  /** 删除用户NS 监测偏好设置 */
  async deleteUserPrefs(userId: number): Promise<void> {
    return executeInternal(
      'DELETE FROM user_ns_monitor_prefs WHERE user_id = ?',
      [userId],
      { operation: 'NSMonitor.deleteUserPrefs', table: 'user_ns_monitor_prefs' }
    );
  },

  // ========== 域名监测列表 ==========

  /** 获取用户所有的域名监测配置 */
  async getUserMonitors(userId: number): Promise<QueryResult[]> {
    return queryInternal(
      `SELECT * FROM ns_monitor_domains
       WHERE user_id = ?
       ORDER BY domain_name`,
      [userId],
      { operation: 'NSMonitor.getUserMonitors', table: 'ns_monitor_domains' }
    );
  },

  /** 分页获取用户所有的域名监测配置（支持关键字搜索） */
  async getUserMonitorsWithPagination(userId: number, page: number, pageSize: number, keyword?: string): Promise<{ list: QueryResult[]; total: number }> {
    const offset = (page - 1) * pageSize;
    const keywordParam = keyword ? `%${keyword}%` : '';

    let countSql = 'SELECT COUNT(*) as count FROM ns_monitor_domains WHERE user_id = ?';
    const countParams: any[] = [userId];
    if (keyword) {
      countSql += ' AND domain_name LIKE ?';
      countParams.push(keywordParam);
    }
    const countResult = await getInternal<{ count: number }>(
      countSql,
      countParams,
      { operation: 'NSMonitor.getUserMonitorsWithPagination.count', table: 'ns_monitor_domains' }
    );
    const total = countResult?.count || 0;

    let listSql = 'SELECT * FROM ns_monitor_domains WHERE user_id = ?';
    const listParams: any[] = [userId];
    if (keyword) {
      listSql += ' AND domain_name LIKE ?';
      listParams.push(keywordParam);
    }
    listSql += ` ORDER BY domain_name LIMIT ${Math.floor(pageSize)} OFFSET ${Math.floor(offset)}`;

    const list = await queryInternal(
      listSql,
      listParams,
      { operation: 'NSMonitor.getUserMonitorsWithPagination', table: 'ns_monitor_domains' }
    );
    return { list, total };
  },

  /** 获取所有启用的域名监测（用于定时任务，Level 2 - 仅检NS 监控自身状态） */
  async getAllEnabled(): Promise<QueryResult[]> {
    const enabledValue = '1';
    return queryInternal(
      `SELECT *, user_id as created_by
       FROM ns_monitor_domains
       WHERE enabled = ${enabledValue}`,
      [],
      { operation: 'NSMonitor.getAllEnabled', table: 'ns_monitor_domains' }
    );
  },

  /** 获取所有域名监测配置（Level 1 - ALL，无任何约束，用于调管理*/
  async getAll(): Promise<QueryResult[]> {
    return queryInternal(
      `SELECT *, user_id as created_by
       FROM ns_monitor_domains
       ORDER BY domain_name`,
      [],
      { operation: 'NSMonitor.getAll', table: 'ns_monitor_domains' }
    );
  },

  /** 根据ID获取域名监测配置 */
  async getById(id: number, userId?: number): Promise<QueryResult | undefined> {
    if (userId) {
      return getInternal(
        `SELECT * FROM ns_monitor_domains
         WHERE id = ? AND user_id = ?`,
        [id, userId],
        { operation: 'NSMonitor.getById', table: 'ns_monitor_domains' }
      );
    }
    return getInternal(
      `SELECT * FROM ns_monitor_domains
       WHERE id = ?`,
      [id],
      { operation: 'NSMonitor.getById', table: 'ns_monitor_domains' }
    );
  },

  /** 根据域名ID获取用户的监测配置（已废弃，使用 getByDomainName*/
  async getByDomain(userId: number, domainId: number): Promise<QueryResult | undefined> {
    // This method is deprecated - domain_id column has been removed
    // Use getByDomainName instead
    log.warn( 'getByDomain is deprecated, use getByDomainName instead');
    return undefined;
  },

  /** 根据域名名称获取用户的监测配置（支持重名场景*/
  async getByDomainName(userId: number, domainName: string): Promise<QueryResult | undefined> {
    return getInternal(
      `SELECT * FROM ns_monitor_domains
       WHERE user_id = ? AND domain_name = ?`,
      [userId, domainName],
      { operation: 'NSMonitor.getByDomainName', table: 'ns_monitor_domains' }
    );
  },

  /** 创建域名监测配置 */
  async create(data: { user_id: number; domain_name: string; expected_ns?: string }): Promise<number> {
    const now = formatDateForDB(new Date());
    return insertInternal(
      `INSERT INTO ns_monitor_domains (user_id, domain_name, expected_ns, current_ns, status, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.user_id, data.domain_name, data.expected_ns || '', '', 'ok', 1, now, now],
      { operation: 'NSMonitor.create', table: 'ns_monitor_domains' }
    );
  },

  /** 更新域名监测配置 */
  async update(id: number, userId: number, updates: Record<string, unknown>): Promise<void> {
    const fields = Object.keys(updates);
    if (fields.length === 0) return;
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = Object.values(updates);
    return executeInternal(
      `UPDATE ns_monitor_domains SET ${setClause} WHERE id = ? AND user_id = ?`,
      [...values, id, userId],
      { operation: 'NSMonitor.update', table: 'ns_monitor_domains' }
    );
  },

  /** 删除域名监测配置 */
  async delete(id: number, userId: number): Promise<void> {
    return executeInternal(
      'DELETE FROM ns_monitor_domains WHERE id = ? AND user_id = ?',
      [id, userId],
      { operation: 'NSMonitor.delete', table: 'ns_monitor_domains' }
    );
  },

  /** 更新监测状态（用于定时任务*/
  async updateStatus(id: number, updates: {
    current_ns?: string;
    encrypted_ns?: string;
    plain_ns?: string;
    is_poisoned?: boolean | number;
    status?: string;
    last_check_at?: string;
    last_alert_at?: string;
    alert_count?: number;
  }): Promise<void> {
    const fields = Object.keys(updates);
    if (fields.length === 0) return;
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = Object.values(updates);
    return executeInternal(
      `UPDATE ns_monitor_domains SET ${setClause} WHERE id = ?`,
      [...values, id],
      { operation: 'NSMonitor.updateStatus', table: 'ns_monitor_domains' }
    );
  },
};

// ============================================================================
// RDAP 服务器缓存操
// ============================================================================

export const RdapCacheOperations = {
  /** 获取所RDAP 服务器缓*/
  async getAll(): Promise<QueryResult[]> {
    return queryInternal(
      'SELECT * FROM rdap_server_cache ORDER BY tld',
      [],
      { operation: 'RdapCache.getAll', table: 'rdap_server_cache' }
    );
  },

  /** 根据 TLD 获取 RDAP 服务*/
  async getByTld(tld: string): Promise<QueryResult | undefined> {
    return getInternal(
      'SELECT * FROM rdap_server_cache WHERE tld = ?',
      [tld.toLowerCase()],
      { operation: 'RdapCache.getByTld', table: 'rdap_server_cache' }
    );
  },

  /** 批量保存 RDAP 服务器缓*/
  async saveBatch(entries: Array<{ tld: string; servers: string[] }>): Promise<void> {
    const dbType = getDbType();
    const now = formatDateForDB(new Date());

    for (const entry of entries) {
      const serversJson = JSON.stringify(entry.servers);

      if (dbType === 'postgresql') {
        // PostgreSQL 使用 ON CONFLICT
        await executeInternal(
          `INSERT INTO rdap_server_cache (tld, servers, created_at, updated_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tld) DO UPDATE SET
           servers = EXCLUDED.servers, updated_at = EXCLUDED.updated_at`,
          [entry.tld.toLowerCase(), serversJson, now, now],
          { operation: 'RdapCache.saveBatch', table: 'rdap_server_cache' }
        );
      } else if (dbType === 'mysql') {
        // MySQL 使用 ON DUPLICATE KEY UPDATE
        await executeInternal(
          `INSERT INTO rdap_server_cache (tld, servers, created_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
           servers = VALUES(servers), updated_at = VALUES(updated_at)`,
          [entry.tld.toLowerCase(), serversJson, now, now],
          { operation: 'RdapCache.saveBatch', table: 'rdap_server_cache' }
        );
      } else {
        // SQLite 使用 REPLACE 或先删除后插
        await executeInternal(
          `INSERT OR REPLACE INTO rdap_server_cache (tld, servers, created_at, updated_at)
           VALUES (?, ?, COALESCE((SELECT created_at FROM rdap_server_cache WHERE tld = ?), ?), ?)`,
          [entry.tld.toLowerCase(), serversJson, entry.tld.toLowerCase(), now, now],
          { operation: 'RdapCache.saveBatch', table: 'rdap_server_cache' }
        );
      }
    }
  },

  /** 清空所RDAP 服务器缓*/
  async clearAll(): Promise<void> {
    return executeInternal(
      'DELETE FROM rdap_server_cache',
      [],
      { operation: 'RdapCache.clearAll', table: 'rdap_server_cache' }
    );
  },

  /** 获取缓存统计信息 */
  async getStats(): Promise<{ count: number; lastUpdated?: string }> {
    const result = await getInternal<{ count: number; last_updated?: string }>(
      'SELECT COUNT(*) as count, MAX(updated_at) as last_updated FROM rdap_server_cache',
      [],
      { operation: 'RdapCache.getStats', table: 'rdap_server_cache' }
    );
    return {
      count: result?.count || 0,
      lastUpdated: result?.last_updated,
    };
  },
};

// ============================================================================
// 系统缓存操作（通用键值缓存）
// ============================================================================

export const SystemCacheOperations = {
  /** 获取缓存*/
  async get(key: string): Promise<string | null> {
    const result = await getInternal<{ cache_value: string }>(
      'SELECT cache_value FROM system_cache WHERE cache_key = ? AND (expires_at IS NULL OR expires_at > ?)',
      [key, formatDateForDB(new Date())],
      { operation: 'SystemCache.get', table: 'system_cache' }
    );
    return result?.cache_value || null;
  },

  /** 设置缓存*/
  async set(key: string, value: string, expiresAt?: Date): Promise<void> {
    const dbType = getDbType();
    const now = formatDateForDB(new Date());
    const expires = expiresAt ? formatDateForDB(expiresAt) : null;

    if (dbType === 'postgresql') {
      await executeInternal(
        `INSERT INTO system_cache (cache_key, cache_value, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (cache_key) DO UPDATE SET
         cache_value = EXCLUDED.cache_value, expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at`,
        [key, value, expires, now, now],
        { operation: 'SystemCache.set', table: 'system_cache' }
      );
    } else if (dbType === 'mysql') {
      await executeInternal(
        `INSERT INTO system_cache (cache_key, cache_value, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
         cache_value = VALUES(cache_value), expires_at = VALUES(expires_at), updated_at = VALUES(updated_at)`,
        [key, value, expires, now, now],
        { operation: 'SystemCache.set', table: 'system_cache' }
      );
    } else {
      await executeInternal(
        `INSERT OR REPLACE INTO system_cache (cache_key, cache_value, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, COALESCE((SELECT created_at FROM system_cache WHERE cache_key = ?), ?), ?)`,
        [key, value, expires, key, now, now],
        { operation: 'SystemCache.set', table: 'system_cache' }
      );
    }
  },

  /** 删除缓存 */
  async delete(key: string): Promise<void> {
    return executeInternal(
      'DELETE FROM system_cache WHERE cache_key = ?',
      [key],
      { operation: 'SystemCache.delete', table: 'system_cache' }
    );
  },

  /** 清理过期缓存 */
  async cleanupExpired(): Promise<number> {
    const result = await runInternal(
      'DELETE FROM system_cache WHERE expires_at IS NOT NULL AND expires_at <= ?',
      [formatDateForDB(new Date())],
      { operation: 'SystemCache.cleanupExpired', table: 'system_cache' }
    );
    return result.changes || 0;
  },
};

function formatDateForDBExpires(expiresAt: Date): string {
  return formatDateForDB(expiresAt);
}

export const GroupedDomainsCacheOperations = {
  async get(userId: number, cacheType: 'domain' | 'account'): Promise<{ version: number; cacheData: string } | null> {
    const now = formatDateForDB(new Date());
    const row = await getInternal<{ version: number; cache_data: string }>(
      'SELECT version, cache_data FROM grouped_domains_cache WHERE user_id = ? AND cache_type = ? AND (expires_at IS NULL OR expires_at > ?)',
      [userId, cacheType, now],
      { operation: 'GroupedDomainsCache.get', table: 'grouped_domains_cache' }
    );
    if (!row) return null;
    return { version: row.version, cacheData: row.cache_data };
  },

  async set(userId: number, cacheType: 'domain' | 'account', version: number, cacheData: string, expiresAt?: Date): Promise<void> {
    const dbType = getDbType();
    const now = formatDateForDB(new Date());
    const expires = expiresAt ? formatDateForDB(expiresAt) : null;

    if (dbType === 'postgresql') {
      await executeInternal(
        `INSERT INTO grouped_domains_cache (user_id, cache_type, version, cache_data, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, cache_type) DO UPDATE SET
         version = EXCLUDED.version, cache_data = EXCLUDED.cache_data, expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at`,
        [userId, cacheType, version, cacheData, expires, now, now],
        { operation: 'GroupedDomainsCache.set', table: 'grouped_domains_cache' }
      );
    } else if (dbType === 'mysql') {
      await executeInternal(
        `INSERT INTO grouped_domains_cache (user_id, cache_type, version, cache_data, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
         version = VALUES(version), cache_data = VALUES(cache_data), expires_at = VALUES(expires_at), updated_at = VALUES(updated_at)`,
        [userId, cacheType, version, cacheData, expires, now, now],
        { operation: 'GroupedDomainsCache.set', table: 'grouped_domains_cache' }
      );
    } else {
      await executeInternal(
        `INSERT OR REPLACE INTO grouped_domains_cache (user_id, cache_type, version, cache_data, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM grouped_domains_cache WHERE user_id = ? AND cache_type = ?), ?), ?)`,
        [userId, cacheType, version, cacheData, expires, userId, cacheType, now, now],
        { operation: 'GroupedDomainsCache.set', table: 'grouped_domains_cache' }
      );
    }
  },

  async delete(userId: number, cacheType: 'domain' | 'account'): Promise<void> {
    await executeInternal(
      'DELETE FROM grouped_domains_cache WHERE user_id = ? AND cache_type = ?',
      [userId, cacheType],
      { operation: 'GroupedDomainsCache.delete', table: 'grouped_domains_cache' }
    );
  },

  /** 清理过期缓存 */
  async cleanupExpired(): Promise<number> {
    const now = formatDateForDB(new Date());
    const result = await runInternal(
      'DELETE FROM grouped_domains_cache WHERE expires_at IS NOT NULL AND expires_at <= ?',
      [now],
      { operation: 'GroupedDomainsCache.cleanupExpired', table: 'grouped_domains_cache' }
    );
    return result.changes || 0;
  },
};

/**
 * Password Reset Operations
 * 密码重置验证码操作（持久化存储）
 */
const PasswordResetOperations = {
  /**
   * 创建或更新密码重置验证码
   */
  async upsertCode(email: string, code: string, expiresAt: number): Promise<void> {
    const normalizedEmail = email.toLowerCase().trim();
    await executeInternal(
      'INSERT INTO password_resets (email, code, expires_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE code = ?, expires_at = ?',
      [normalizedEmail, code, new Date(expiresAt), code, new Date(expiresAt)],
      { operation: 'PasswordReset.upsertCode', table: 'password_resets' }
    );
  },

  /**
   * 获取密码重置验证
   */
  async getCode(email: string): Promise<{ code: string; expiresAt: number } | null> {
    const normalizedEmail = email.toLowerCase().trim();
    const row = await getInternal<{ code: string; expires_at: string }>(
      'SELECT code, expires_at FROM password_resets WHERE email = ? AND expires_at > NOW()',
      [normalizedEmail],
      { operation: 'PasswordReset.getCode', table: 'password_resets' }
    );

    if (!row) return null;

    return {
      code: row.code,
      expiresAt: new Date(row.expires_at).getTime(),
    };
  },

  /**
   * 删除密码重置验证
   */
  async deleteCode(email: string): Promise<void> {
    const normalizedEmail = email.toLowerCase().trim();
    await executeInternal(
      'DELETE FROM password_resets WHERE email = ?',
      [normalizedEmail],
      { operation: 'PasswordReset.deleteCode', table: 'password_resets' }
    );
  },

  /**
   * 清理过期的验证码
   */
  async cleanupExpired(): Promise<number> {
    const result = await runInternal(
      'DELETE FROM password_resets WHERE expires_at <= NOW()',
      [],
      { operation: 'PasswordReset.cleanupExpired', table: 'password_resets' }
    );
    return result.changes;
  },
};

// ============================================================================
// MCP (Model Context Protocol) 业务操作
// ============================================================================

export const McpOperations = {
  // ========================================
  // 全局配置
  // ========================================

  /** 获取 MCP 全局配置 */
  async getGlobalConfig(): Promise<{ id: number; enabled: boolean; updated_by?: number; updated_at: string } | null> {
    const config = await getInternal<{
      id: number;
      enabled: number | boolean;
      updated_by?: number;
      updated_at: string;
    }>(
      'SELECT * FROM mcp_global_config ORDER BY id DESC LIMIT 1',
      [],
      { operation: 'Mcp.getGlobalConfig', table: 'mcp_global_config' }
    );
    if (!config) return null;
    // Convert stored integer (0/1) to proper boolean
    return { ...config, enabled: !!config.enabled };
  },

  /** 更新 MCP 全局配置 */
  async updateGlobalConfig(enabled: boolean, userId?: number): Promise<void> {
    const existing = await McpOperations.getGlobalConfig();

    if (existing) {
      await executeInternal(
        'UPDATE mcp_global_config SET enabled = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [enabled, userId || null, existing.id],
        { operation: 'Mcp.updateGlobalConfig', table: 'mcp_global_config', userId }
      );
    } else {
      await executeInternal(
        'INSERT INTO mcp_global_config (enabled, updated_by, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
        [enabled, userId || null],
        { operation: 'Mcp.updateGlobalConfig', table: 'mcp_global_config', userId }
      );
    }
  },

  // ========================================
  // API Key 管理
  // ========================================

  /** 创建 API Key */
  async createApiKey(userId: number, apiKey: string, description: string, expiresAt?: string): Promise<void> {
    await executeInternal(
      'INSERT INTO mcp_user_api_keys (user_id, api_key, description, expires_at, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
      [userId, apiKey, description, expiresAt || null],
      { operation: 'Mcp.createApiKey', table: 'mcp_user_api_keys', userId }
    );
  },

  /** 验证 API Key */
  async validateApiKey(apiKey: string): Promise<{ id: number; user_id: number; description: string; expires_at?: string; revoked_at?: string } | null> {
    const key = await getInternal<{
      id: number;
      user_id: number;
      description: string;
      expires_at?: string;
      revoked_at?: string;
    }>(
      'SELECT id, user_id, description, expires_at, revoked_at FROM mcp_user_api_keys WHERE api_key = ? AND revoked_at IS NULL',
      [apiKey],
      { operation: 'Mcp.validateApiKey', table: 'mcp_user_api_keys' }
    );

    if (!key) return null;

    // 检查是否过期
    if (key.expires_at && new Date(key.expires_at) < new Date()) {
      return null;
    }

    return key;
  },

  /** 更新 API Key 最后使用时间 */
  async updateApiKeyLastUsed(keyId: number): Promise<void> {
    await executeInternal(
      'UPDATE mcp_user_api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?',
      [keyId],
      { operation: 'Mcp.updateApiKeyLastUsed', table: 'mcp_user_api_keys' }
    );
  },

  /** 获取用户的 API Keys */
  async getUserApiKeys(userId: number): Promise<Array<{ id: number; api_key: string; description: string; last_used_at?: string; expires_at?: string; revoked_at?: string; created_at: string }>> {
    return queryInternal<{
      id: number;
      api_key: string;
      description: string;
      last_used_at?: string;
      expires_at?: string;
      revoked_at?: string;
      created_at: string;
    }>(
      'SELECT id, api_key, description, last_used_at, expires_at, revoked_at, created_at FROM mcp_user_api_keys WHERE user_id = ? ORDER BY created_at DESC',
      [userId],
      { operation: 'Mcp.getUserApiKeys', table: 'mcp_user_api_keys', userId }
    );
  },

  /** 撤销 API Key */
  async revokeApiKey(keyId: number, userId: number): Promise<void> {
    await executeInternal(
      'UPDATE mcp_user_api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
      [keyId, userId],
      { operation: 'Mcp.revokeApiKey', table: 'mcp_user_api_keys', userId }
    );
  },

  /** 恢复（取消撤销）API Key */
  async restoreApiKey(keyId: number, userId: number): Promise<void> {
    await executeInternal(
      'UPDATE mcp_user_api_keys SET revoked_at = NULL WHERE id = ? AND user_id = ?',
      [keyId, userId],
      { operation: 'Mcp.restoreApiKey', table: 'mcp_user_api_keys', userId }
    );
  },

  /** 更新 API Key 授权到期日期 */
  async updateApiKeyExpiry(keyId: number, userId: number, expiresAt: string | null): Promise<void> {
    await executeInternal(
      "UPDATE mcp_user_api_keys SET expires_at = ? WHERE id = ? AND user_id = ?",
      [expiresAt, keyId, userId],
      { operation: 'Mcp.updateApiKeyExpiry', table: 'mcp_user_api_keys', userId }
    );
  },

  /** 删除 API Key */
  async deleteApiKey(keyId: number, userId: number): Promise<void> {
    await executeInternal(
      'DELETE FROM mcp_user_api_keys WHERE id = ? AND user_id = ?',
      [keyId, userId],
      { operation: 'Mcp.deleteApiKey', table: 'mcp_user_api_keys', userId }
    );
  },

  // ========================================
  // OAuth2 客户端管理
  // ========================================

  /** 创建 OAuth2 客户端 */
  async createOAuthClient(data: {
    client_id: string;
    client_secret: string;
    user_id?: number;
    app_name: string;
    redirect_uris: string;
    scope?: string;
    expires_at?: string;
  }): Promise<void> {
    if (data.expires_at) {
      await executeInternal(
        'INSERT INTO mcp_oauth_clients (client_id, client_secret, user_id, app_name, redirect_uris, scope, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
        [data.client_id, data.client_secret, data.user_id ?? null, data.app_name, data.redirect_uris, data.scope || null, data.expires_at],
        { operation: 'Mcp.createOAuthClient', table: 'mcp_oauth_clients', userId: data.user_id ?? 0 }
      );
    } else {
      await executeInternal(
        'INSERT INTO mcp_oauth_clients (client_id, client_secret, user_id, app_name, redirect_uris, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
        [data.client_id, data.client_secret, data.user_id ?? null, data.app_name, data.redirect_uris, data.scope || null],
        { operation: 'Mcp.createOAuthClient', table: 'mcp_oauth_clients', userId: data.user_id ?? 0 }
      );
    }
  },

  /** 获取 OAuth2 客户端 */
  async getOAuthClient(clientId: string): Promise<{
    id: number;
    client_id: string;
    client_secret: string;
    user_id: number;
    app_name: string;
    redirect_uris: string;
    scope?: string;
    expires_at?: string;
  } | null> {
    const result = await getInternal<{
      id: number;
      client_id: string;
      client_secret: string;
      user_id: number;
      app_name: string;
      redirect_uris: string;
      scope?: string;
      expires_at?: string;
    }>(
      'SELECT * FROM mcp_oauth_clients WHERE client_id = ?',
      [clientId],
      { operation: 'Mcp.getOAuthClient', table: 'mcp_oauth_clients' }
    );
    return result || null;
  },

  /** 获取用户的 OAuth2 客户端列表 */
  async getUserOAuthClients(userId: number): Promise<Array<{
    id: number;
    client_id: string;
    app_name: string;
    redirect_uris: string;
    scope?: string;
    expires_at?: string;
    created_at: string;
    updated_at: string;
  }>> {
    return queryInternal<{
      id: number;
      client_id: string;
      app_name: string;
      redirect_uris: string;
      scope?: string;
      expires_at?: string;
      created_at: string;
      updated_at: string;
    }>(
      'SELECT id, client_id, app_name, redirect_uris, scope, expires_at, created_at, updated_at FROM mcp_oauth_clients WHERE user_id = ? ORDER BY created_at DESC',
      [userId],
      { operation: 'Mcp.getUserOAuthClients', table: 'mcp_oauth_clients', userId }
    );
  },

  /** 删除 OAuth2 客户端 */
  async deleteOAuthClient(clientId: string, userId: number): Promise<void> {
    await executeInternal(
      'DELETE FROM mcp_oauth_clients WHERE client_id = ? AND user_id = ?',
      [clientId, userId],
      { operation: 'Mcp.deleteOAuthClient', table: 'mcp_oauth_clients', userId }
    );
  },

  /** 更新 OAuth 客户端授权范围 */
  async updateOAuthClientScope(clientId: string, userId: number, scope: string): Promise<void> {
    await executeInternal(
      "UPDATE mcp_oauth_clients SET scope = ?, updated_at = CURRENT_TIMESTAMP WHERE client_id = ? AND user_id = ?",
      [scope, clientId, userId],
      { operation: 'Mcp.updateOAuthClientScope', table: 'mcp_oauth_clients', userId }
    );
  },

  /** 更新 OAuth 客户端授权到期日期 */
  async updateOAuthClientExpiry(clientId: string, userId: number, expiresAt: string | null): Promise<void> {
    await executeInternal(
      "UPDATE mcp_oauth_clients SET expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE client_id = ? AND user_id = ?",
      [expiresAt, clientId, userId],
      { operation: 'Mcp.updateOAuthClientExpiry', table: 'mcp_oauth_clients', userId }
    );
  },

  /** 验证客户端凭证（client_credentials grant） */
  async validateClientCredentials(clientId: string, clientSecret: string): Promise<{
    id: number;
    user_id: number;
    app_name: string;
    scope?: string;
  } | null> {
    const client = await getInternal<{
      id: number;
      user_id: number;
      app_name: string;
      scope?: string;
      client_secret: string;
      expires_at?: string;
    }>(
      'SELECT id, user_id, app_name, scope, client_secret, expires_at FROM mcp_oauth_clients WHERE client_id = ?',
      [clientId],
      { operation: 'Mcp.validateClientCredentials', table: 'mcp_oauth_clients' }
    );

    if (!client) return null;
    if (client.client_secret !== clientSecret) return null;
    if (client.expires_at && new Date(client.expires_at) < new Date()) return null;

    return { id: client.id, user_id: client.user_id, app_name: client.app_name, scope: client.scope };
  },

  /** 清理所有未分配用户的临时 OAuth 客户端（重启时调用） */
  async cleanupUnassignedOAuthClients(): Promise<number> {
    const result = await runInternal(
      'DELETE FROM mcp_oauth_clients WHERE user_id IS NULL',
      [],
      { operation: 'Mcp.cleanupUnassignedOAuthClients', table: 'mcp_oauth_clients' }
    );
    return result.changes || 0;
  },

  /** 清理超过 25 分钟仍未授权的临时客户端 */
  async cleanupExpiredUnassignedClients(): Promise<number> {
    const expiresStr = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    const result = await runInternal(
      'DELETE FROM mcp_oauth_clients WHERE user_id IS NULL AND created_at < ?',
      [expiresStr],
      { operation: 'Mcp.cleanupExpiredUnassignedClients', table: 'mcp_oauth_clients' }
    );
    return result.changes || 0;
  },

  /** 获取所有访问令牌（含客户端名称） */
  async getOAuthAccessTokens(userId: number): Promise<Array<{
    id: number;
    access_token: string;
    client_id: string;
    app_name: string;
    scope?: string;
    expires_at: string;
    revoked_at?: string;
    created_at: string;
  }>> {
    const tokens = await queryInternal<{
      id: number;
      access_token: string;
      client_id: string;
      app_name: string;
      scope?: string;
      expires_at: string;
      revoked_at?: string;
      created_at: string;
    }>(
      `SELECT t.id, t.access_token, t.client_id, c.app_name, t.scope, t.expires_at, t.revoked_at, t.created_at
       FROM mcp_oauth_access_tokens t
       JOIN mcp_oauth_clients c ON t.client_id = c.client_id
       WHERE c.user_id = ?
       ORDER BY t.created_at DESC`,
      [userId],
      { operation: 'Mcp.getOAuthAccessTokens', table: 'mcp_oauth_access_tokens', userId }
    );
    return tokens;
  },

  /** 按 ID 撤销访问令牌 */
  async revokeOAuthTokenById(tokenId: number, userId: number): Promise<void> {
    await executeInternal(
      'UPDATE mcp_oauth_access_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND client_id IN (SELECT client_id FROM mcp_oauth_clients WHERE user_id = ?)',
      [tokenId, userId],
      { operation: 'Mcp.revokeOAuthTokenById', table: 'mcp_oauth_access_tokens', userId }
    );
  },

  // ========================================
  // OAuth2 Token 管理
  // ========================================

  /** 创建 Access Token */
  async createAccessToken(data: {
    access_token: string;
    refresh_token: string;
    client_id: string;
    user_id: number;
    scope?: string;
    expires_at: string;
  }): Promise<void> {
    await executeInternal(
      'INSERT INTO mcp_oauth_access_tokens (access_token, refresh_token, client_id, user_id, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
      [data.access_token, data.refresh_token, data.client_id, data.user_id, data.scope || null, data.expires_at],
      { operation: 'Mcp.createAccessToken', table: 'mcp_oauth_access_tokens', userId: data.user_id }
    );
  },

  /** 验证 Access Token */
  async validateAccessToken(accessToken: string): Promise<{
    id: number;
    access_token: string;
    refresh_token: string;
    client_id: string;
    user_id: number;
    scope?: string;
    expires_at: string;
  } | null> {
    const token = await getInternal<{
      id: number;
      access_token: string;
      refresh_token: string;
      client_id: string;
      user_id: number;
      scope?: string;
      expires_at: string;
    }>(
      'SELECT * FROM mcp_oauth_access_tokens WHERE access_token = ? AND revoked_at IS NULL',
      [accessToken],
      { operation: 'Mcp.validateAccessToken', table: 'mcp_oauth_access_tokens' }
    );

    if (!token) return null;

    // 检查是否过期
    if (new Date(token.expires_at) < new Date()) {
      return null;
    }

    return token;
  },

  /** 撤销 Access Token */
  async revokeAccessToken(accessToken: string): Promise<void> {
    await executeInternal(
      'UPDATE mcp_oauth_access_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE access_token = ?',
      [accessToken],
      { operation: 'Mcp.revokeAccessToken', table: 'mcp_oauth_access_tokens' }
    );
  },

  // ========================================
  // OAuth2 Authorization Code Flow
  // ========================================

  /** 创建 Authorization Code */
  async createAuthCode(data: {
    code: string;
    client_id: string;
    user_id: number;
    redirect_uri: string;
    scope: string | null;
    expires_at: string;
  }): Promise<void> {
    await executeInternal(
      'INSERT INTO mcp_oauth_auth_codes (code, client_id, user_id, redirect_uri, scope, expires_at, used, created_at) VALUES (?, ?, ?, ?, ?, ?, false, CURRENT_TIMESTAMP)',
      [data.code, data.client_id, data.user_id, data.redirect_uri, data.scope, data.expires_at],
      { operation: 'Mcp.createAuthCode', table: 'mcp_oauth_auth_codes', userId: data.user_id }
    );
  },

  /** 验证并消费 Authorization Code */
  async consumeAuthCode(code: string): Promise<{
    client_id: string;
    user_id: number;
    redirect_uri: string;
    scope: string | null;
  } | null> {
    const row = await getInternal<{
      id: number;
      client_id: string;
      user_id: number;
      redirect_uri: string;
      scope: string | null;
      expires_at: string;
      used: number;
    }>(
      'SELECT * FROM mcp_oauth_auth_codes WHERE code = ?',
      [code],
      { operation: 'Mcp.consumeAuthCode', table: 'mcp_oauth_auth_codes' }
    );

    if (!row) return null;
    if (row.used) return null;
    if (new Date(row.expires_at) < new Date()) return null;

    // 标记为已使用
    await executeInternal(
      'UPDATE mcp_oauth_auth_codes SET used = true WHERE id = ?',
      [row.id],
      { operation: 'Mcp.consumeAuthCode.markUsed', table: 'mcp_oauth_auth_codes' }
    );

    return {
      client_id: row.client_id,
      user_id: row.user_id,
      redirect_uri: row.redirect_uri,
      scope: row.scope,
    };
  },

  /** 验证 Refresh Token */
  async validateRefreshToken(refreshToken: string): Promise<{
    id: number;
    client_id: string;
    user_id: number;
    scope: string | null;
    expires_at: string;
  } | null> {
    const row = await getInternal<{
      id: number;
      client_id: string;
      user_id: number;
      scope: string | null;
      expires_at: string;
      revoked_at: string | null;
    }>(
      'SELECT * FROM mcp_oauth_refresh_tokens WHERE refresh_token = ?',
      [refreshToken],
      { operation: 'Mcp.validateRefreshToken', table: 'mcp_oauth_refresh_tokens' }
    );

    if (!row) return null;
    if (row.revoked_at) return null;
    if (new Date(row.expires_at) < new Date()) return null;

    return {
      id: row.id,
      client_id: row.client_id,
      user_id: row.user_id,
      scope: row.scope,
      expires_at: row.expires_at,
    };
  },

  /** 创建 Refresh Token */
  async createRefreshToken(data: {
    refresh_token: string;
    client_id: string;
    user_id: number;
    scope: string | null;
    expires_at: string;
  }): Promise<void> {
    await executeInternal(
      'INSERT INTO mcp_oauth_refresh_tokens (refresh_token, client_id, user_id, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
      [data.refresh_token, data.client_id, data.user_id, data.scope, data.expires_at],
      { operation: 'Mcp.createRefreshToken', table: 'mcp_oauth_refresh_tokens', userId: data.user_id }
    );
  },

  /** 撤销 Refresh Token（及其关联的 access tokens） */
  async revokeRefreshToken(refreshToken: string): Promise<void> {
    const row = await getInternal<{ id: number; client_id: string; user_id: number }>(
      'SELECT id, client_id, user_id FROM mcp_oauth_refresh_tokens WHERE refresh_token = ?',
      [refreshToken],
      { operation: 'Mcp.revokeRefreshToken.find', table: 'mcp_oauth_refresh_tokens' }
    );

    if (!row) return;

    await executeInternal(
      'UPDATE mcp_oauth_refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?',
      [row.id],
      { operation: 'Mcp.revokeRefreshToken.revoke', table: 'mcp_oauth_refresh_tokens', userId: row.user_id }
    );

    // 同时撤销关联的 access tokens
    await executeInternal(
      'UPDATE mcp_oauth_access_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE client_id = ? AND user_id = ? AND revoked_at IS NULL',
      [row.client_id, row.user_id],
      { operation: 'Mcp.revokeRefreshToken.revokeAccess', table: 'mcp_oauth_access_tokens', userId: row.user_id }
    );
  },

  /** 按 refresh_token 查找有效的 access token */
  async getAccessTokenByRefreshToken(refreshToken: string): Promise<{
    id: number;
    access_token: string;
    client_id: string;
    user_id: number;
  } | null> {
    const row = await getInternal<{
      id: number;
      access_token: string;
      client_id: string;
      user_id: number;
    }>(
      'SELECT id, access_token, client_id, user_id FROM mcp_oauth_access_tokens WHERE refresh_token = ? AND revoked_at IS NULL',
      [refreshToken],
      { operation: 'Mcp.getAccessTokenByRefreshToken', table: 'mcp_oauth_access_tokens' }
    );
    return row || null;
  },

  /** 按 token 值查找 access token（用于 introspection） */
  async getAccessTokenByValue(accessToken: string): Promise<{
    id: number;
    access_token: string;
    refresh_token: string;
    client_id: string;
    user_id: number;
    scope?: string;
    expires_at: string;
    revoked_at: string | null;
    created_at: string;
  } | null> {
    const token = await getInternal<{
      id: number;
      access_token: string;
      refresh_token: string;
      client_id: string;
      user_id: number;
      scope?: string;
      expires_at: string;
      revoked_at: string | null;
      created_at: string;
    }>(
      'SELECT * FROM mcp_oauth_access_tokens WHERE access_token = ?',
      [accessToken],
      { operation: 'Mcp.getAccessTokenByValue', table: 'mcp_oauth_access_tokens' }
    );
    return token || null;
  },

  /** 按值撤销 access token（用于 RFC 7009 revocation） */
  async revokeAccessTokenByValue(accessToken: string): Promise<void> {
    await executeInternal(
      'UPDATE mcp_oauth_access_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE access_token = ? AND revoked_at IS NULL',
      [accessToken],
      { operation: 'Mcp.revokeAccessTokenByValue', table: 'mcp_oauth_access_tokens' }
    );
  },

  /** 按值撤销 refresh token */
  async revokeRefreshTokenByValue(refreshToken: string): Promise<void> {
    await executeInternal(
      'UPDATE mcp_oauth_refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE refresh_token = ? AND revoked_at IS NULL',
      [refreshToken],
      { operation: 'Mcp.revokeRefreshTokenByValue', table: 'mcp_oauth_refresh_tokens' }
    );
  },

  /** 按值查找 refresh token */
  async getRefreshTokenByValue(refreshToken: string): Promise<{
    id: number;
    refresh_token: string;
    client_id: string;
    user_id: number;
    scope?: string;
    expires_at: string;
    revoked_at: string | null;
    created_at: string;
  } | null> {
    const token = await getInternal<{
      id: number;
      refresh_token: string;
      client_id: string;
      user_id: number;
      scope?: string;
      expires_at: string;
      revoked_at: string | null;
      created_at: string;
    }>(
      'SELECT * FROM mcp_oauth_refresh_tokens WHERE refresh_token = ?',
      [refreshToken],
      { operation: 'Mcp.getRefreshTokenByValue', table: 'mcp_oauth_refresh_tokens' }
    );
    return token || null;
  },

  // ========================================
  // 审计日志
  // ========================================

  /** 记录 MCP 审计日志 */
  async logAudit(data: {
    user_id: number;
    auth_type: string;
    client_id?: string;
    module: string;
    action: string;
    resource_type?: string;
    resource_id?: string;
    request_params?: string;
    response_status?: string;
    ip_address?: string;
  }): Promise<void> {
    await executeInternal(
      'INSERT INTO mcp_audit_logs (user_id, auth_type, client_id, module, action, resource_type, resource_id, request_params, response_status, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
      [
        data.user_id,
        data.auth_type,
        data.client_id || null,
        data.module,
        data.action,
        data.resource_type || null,
        data.resource_id || null,
        data.request_params || null,
        data.response_status || null,
        data.ip_address || null,
      ],
      { operation: 'Mcp.logAudit', table: 'mcp_audit_logs', userId: data.user_id }
    );
  },

  /** 获取 MCP 审计日志 */
  async getAuditLogs(options: {
    userId?: number;
    module?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<Array<{
    id: number;
    user_id: number;
    auth_type: string;
    client_id?: string;
    module: string;
    action: string;
    resource_type?: string;
    resource_id?: string;
    request_params?: string;
    response_status?: string;
    ip_address?: string;
    created_at: string;
  }>> {
    let sql = 'SELECT * FROM mcp_audit_logs WHERE 1=1';
    const params: unknown[] = [];

    if (options.userId) {
      sql += ' AND user_id = ?';
      params.push(options.userId);
    }

    if (options.module) {
      sql += ' AND module = ?';
      params.push(options.module);
    }

    sql += ' ORDER BY created_at DESC';

    const dbType = getDbType();
    if (options.limit) {
      if (dbType === 'mysql') {
        sql += ` LIMIT ${Number(options.limit)}`;
      } else {
        sql += ' LIMIT ?';
        params.push(Number(options.limit));
      }
    }

    if (options.offset) {
      if (dbType === 'mysql') {
        sql += ` OFFSET ${Number(options.offset)}`;
      } else {
        sql += ' OFFSET ?';
        params.push(Number(options.offset));
      }
    }

    return queryInternal<{
      id: number;
      user_id: number;
      auth_type: string;
      client_id?: string;
      module: string;
      action: string;
      resource_type?: string;
      resource_id?: string;
      request_params?: string;
      response_status?: string;
      ip_address?: string;
      created_at: string;
    }>(sql, params, { operation: 'Mcp.getAuditLogs', table: 'mcp_audit_logs' });
  },
};

// ============================================================================
// 导出默认对象（兼容旧代码
// ============================================================================

// 导出 database 对象（向后兼容）
export const database = {
  query,
  get,
  execute,
  insert,
  run,
  now,
  get type() { return getDbType(); },
  get isConnected() { return isDbConnected(); },
  transaction: withTransaction,
};

export default {
  query,
  get,
  execute,
  insert,
  run,
  now,
  getDbType,
  isDbConnected,
  withTransaction,
  User: UserOperations,
  DnsAccount: DnsAccountOperations,
  Domain: DomainOperations,
  Team: TeamOperations,
  Settings: SettingsOperations,
  Audit: AuditOperations,
  Token: TokenOperations,
  Secret: SecretOperations,
  SecurityPolicy: SecurityPolicyOperations,
  TrustedDevice: TrustedDeviceOperations,
  UserPreferences: UserPreferencesOperations,
  Session: SessionOperations,
  LoginLimit: LoginLimitOperations,
  Failover: FailoverOperations,
  AuditExport: AuditExportOperations,
  TOTP: TOTPOperations,
  WebAuthn: WebAuthnOperations,
  Smtp: SmtpOperations,
  Whois: WhoisOperations,
  AuditRules: AuditRulesOperations,
  AuditLog: AuditLogOperations,
  NSMonitor: NSMonitorOperations,
  RdapCache: RdapCacheOperations,
  SystemCache: SystemCacheOperations,
  GroupedDomainsCache: GroupedDomainsCacheOperations,
  RenewableDomain: RenewableDomainOperations,
  PasswordReset: PasswordResetOperations,
  Mcp: McpOperations,
};


// ============================================================================
// 工作流业务操作
// 设计依据：docs/WORKFLOW_ENGINE_DESIGN.md §八（数据模型，经 BAL）
// ============================================================================

export interface WorkflowRow {
  id: number;
  name: string;
  owner_id: number;
  enabled: number;
  trigger_type: string;
  trigger_config: string | null;
  definition: string;
  created_at: string;
  updated_at: string;
}

export interface WorkflowRunRow {
  id: number;
  workflow_id: number;
  trace_id: string;
  status: string;
  trigger_event: string | null;
  error: string | null;
  depth: number;
  started_at: string;
  finished_at: string | null;
}

export const WorkflowOperations = {
  async listByOwner(ownerId: number): Promise<WorkflowRow[]> {
    return queryInternal<WorkflowRow>(
      'SELECT * FROM workflows WHERE owner_id = ? ORDER BY id DESC',
      [ownerId],
      { operation: 'Workflow.listByOwner', table: 'workflows' }
    );
  },

  /** 仅返回启用的工作流；引擎只消费这一批 */
  async listEnabled(): Promise<WorkflowRow[]> {
    return queryInternal<WorkflowRow>(
      'SELECT * FROM workflows WHERE enabled = 1 ORDER BY id ASC',
      [],
      { operation: 'Workflow.listEnabled', table: 'workflows' }
    );
  },

  async getById(id: number): Promise<WorkflowRow | undefined> {
    return getInternal<WorkflowRow>('SELECT * FROM workflows WHERE id = ?', [id], {
      operation: 'Workflow.getById',
      table: 'workflows',
    });
  },

  async create(data: {
    name: string;
    owner_id: number;
    enabled: number;
    trigger_type: string;
    trigger_config: string | null;
    definition: string;
  }): Promise<number> {
    // 用 insertInternal 取真实 insertId："INSERT 后再 SELECT 最大 id" 在并发下会拿到同一条
    return insertInternal(
      'INSERT INTO workflows (name, owner_id, enabled, trigger_type, trigger_config, definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [data.name, data.owner_id, data.enabled, data.trigger_type, data.trigger_config, data.definition],
      { operation: 'Workflow.create', table: 'workflows' }
    );
  },

  async update(id: number, updates: {
    name?: string;
    enabled?: number;
    trigger_type?: string;
    trigger_config?: string | null;
    definition?: string;
  }): Promise<void> {
    const fields: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) continue;
      fields.push(`${key} = ?`);
      params.push(value);
    }
    if (!fields.length) return;
    params.push(id);
    await executeInternal(
      `UPDATE workflows SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      params,
      { operation: 'Workflow.update', table: 'workflows' }
    );
  },

  async remove(id: number): Promise<void> {
    // 先清运行记录：workflow_runs 无外键级联时会产生永不回收的孤儿行
    await executeInternal('DELETE FROM workflow_runs WHERE workflow_id = ?', [id], {
      operation: 'Workflow.remove.runs',
      table: 'workflow_runs',
    });
    await executeInternal('DELETE FROM workflows WHERE id = ?', [id], {
      operation: 'Workflow.remove',
      table: 'workflows',
    });
  },

  async insertRun(data: {
    workflow_id: number;
    trace_id: string;
    status: string;
    trigger_event?: string | null;
    error?: string | null;
    depth?: number;
    started_at?: string;
    finished_at?: string | null;
  }): Promise<void> {
    await executeInternal(
      'INSERT INTO workflow_runs (workflow_id, trace_id, status, trigger_event, error, depth, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        data.workflow_id,
        data.trace_id,
        data.status,
        data.trigger_event ?? null,
        data.error ?? null,
        data.depth ?? 0,
        data.started_at ?? new Date().toISOString(),
        data.finished_at ?? null,
      ],
      { operation: 'Workflow.insertRun', table: 'workflow_runs' }
    );
  },

  /**
   * 每个工作流只保留最近 keep 条运行记录。
   * 分两步（先查保留 id 再按 id 删除）以兼容 SQLite / MySQL / PostgreSQL。
   */
  async pruneRuns(workflowId: number, keep: number): Promise<number> {
    const rows = await queryInternal<{ id: number }>(
      'SELECT id FROM workflow_runs WHERE workflow_id = ? ORDER BY id DESC LIMIT ?',
      [workflowId, Math.max(1, keep)],
      { operation: 'Workflow.pruneRuns.select', table: 'workflow_runs' }
    );
    if (!rows.length) return 0;
    const keepIds = rows.map((row) => row.id);
    const placeholders = keepIds.map(() => '?').join(',');
    const before = await queryInternal<{ id: number }>(
      'SELECT id FROM workflow_runs WHERE workflow_id = ?',
      [workflowId],
      { operation: 'Workflow.pruneRuns.count', table: 'workflow_runs' }
    );
    await executeInternal(
      `DELETE FROM workflow_runs WHERE workflow_id = ? AND id NOT IN (${placeholders})`,
      [workflowId, ...keepIds],
      { operation: 'Workflow.pruneRuns.delete', table: 'workflow_runs' }
    );
    return Math.max(0, before.length - keepIds.length);
  },

  async listRuns(workflowId: number, limit = 50): Promise<WorkflowRunRow[]> {
    return queryInternal<WorkflowRunRow>(
      'SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY id DESC LIMIT ?',
      [workflowId, Math.min(limit, 200)],
      { operation: 'Workflow.listRuns', table: 'workflow_runs' }
    );
  },
};
// Export query builders module for advanced usage
export * from './query-builders';
