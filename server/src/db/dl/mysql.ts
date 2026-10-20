/**
 * MySQL 数据库驱动
 */

import type { Transaction, ColumnType } from '../dal/types';
import type { DriverConfig } from './types';
import { BaseDriver } from './base';
import { registerDriver } from './types';
import { createLogger } from '../../lib/logger';

const log = createLogger('DL').sub('MySQL');

/** MySQL 配置 */
export interface MySQLDriverConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
  connectionLimit?: number;
  connectTimeout?: number;
  acquireTimeout?: number;
  timeout?: number;
}

/** MySQL 驱动实现 */
export class MySQLDriver extends BaseDriver {
  readonly type = 'mysql' as const;
  private pool: any; // Pool
  private connectionConfig: MySQLDriverConfig;

  constructor(config: MySQLDriverConfig, driverConfig?: DriverConfig) {
    super(driverConfig);
    this.connectionConfig = config;

    try {
      // 动态导入 mysql2 模块
      const mysql = require('mysql2/promise');

      log.info( 'Creating connection pool', {
        host: config.host,
        port: config.port,
        database: config.database
      });

      this.pool = mysql.createPool({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password,
        ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
        waitForConnections: true,
        connectionLimit: config.connectionLimit || 20,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
        connectTimeout: config.connectTimeout || 60000,
      });

      log.info( 'Connection pool created successfully');
    } catch (error) {
      log.error( 'Failed to create connection pool', {
        host: config.host,
        port: config.port,
        database: config.database,
        error
      });
      throw new Error(
        `Failed to initialize MySQL driver: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  get isConnected(): boolean {
    try {
      return this.pool !== null;
    } catch {
      return false;
    }
  }

  async query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
    this._stats.queries++;
    const startTime = Date.now();

    try {
      const [rows] = await this.pool.execute(sql, params);
      const duration = Date.now() - startTime;

      if (duration > (this.config.slowQueryThreshold || 100)) {
        log.warn( 'Slow query detected', { sql: sql.substring(0, 100), duration });
      }

      return rows as T[];
    } catch (error) {
      this._stats.errors++;
      log.error( 'Query error', { sql: sql.substring(0, 100), error });
      throw error;
    }
  }

  async get<T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params);
    return rows[0];
  }

  async execute(sql: string, params?: unknown[]): Promise<void> {
    await this.query(sql, params);
  }

  async insert(sql: string, params?: unknown[]): Promise<number> {
    const [result]: any = await this.pool.execute(sql, params);
    return result.insertId;
  }

  async run(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    const [result]: any = await this.pool.execute(sql, params);
    return { changes: result.affectedRows };
  }

  async beginTransaction(): Promise<Transaction> {
    const connection = await this.pool.getConnection();
    await connection.beginTransaction();

    return {
      // 归还连接到池。漏掉这一步会让事务永久占用一个连接。
      done: () => connection.release(),
      query: async <T = unknown>(sql: string, params?: unknown[]): Promise<T[]> => {
        const [rows] = await connection.execute(sql, params);
        return rows as T[];
      },
      get: async <T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined> => {
        const [rows] = await connection.execute(sql, params);
        return (rows as T[])[0];
      },
      execute: async (sql: string, params?: unknown[]): Promise<void> => {
        await connection.execute(sql, params);
      },
      insert: async (sql: string, params?: unknown[]): Promise<number> => {
        const [result]: any = await connection.execute(sql, params);
        return result.insertId;
      },
      run: async (sql: string, params?: unknown[]): Promise<{ changes: number }> => {
        const [result]: any = await connection.execute(sql, params);
        return { changes: result.affectedRows };
      },
    };
  }

  raw(): any {
    return this.pool;
  }

  async close(): Promise<void> {
    log.info( 'Closing connection pool', { stats: this._stats });
    await this.pool.end();
  }

  // ==================== SQL 方言 ====================

  escapeIdentifier(name: string): string {
    return `\`${name}\``;
  }

  placeholder(): string {
    return '?';
  }

  mapType(type: ColumnType, options?: { length?: number; precision?: number; scale?: number }): string {
    switch (type) {
      case 'string':
        return options?.length ? `VARCHAR(${options.length})` : 'TEXT';
      case 'text':
        return 'LONGTEXT';
      case 'integer':
        return 'INT';
      case 'bigint':
        return 'BIGINT';
      case 'decimal':
        return options?.precision && options?.scale
          ? `DECIMAL(${options.precision}, ${options.scale})`
          : 'DECIMAL';
      case 'boolean':
        return 'TINYINT(1)';
      case 'datetime':
        return 'DATETIME';
      case 'timestamp':
        return 'TIMESTAMP';
      case 'date':
        return 'DATE';
      case 'json':
        return 'JSON';
      case 'uuid':
        return 'CHAR(36)';
      case 'serial':
        return 'INT AUTO_INCREMENT PRIMARY KEY';
      default:
        return 'TEXT';
    }
  }

  now(): string {
    return 'NOW()';
  }

  dateDiff(a: string, b: string): string {
    return `TIMESTAMPDIFF(SECOND, ${b}, ${a})`;
  }

  limitOffset(limit: number, offset?: number): string {
    if (offset !== undefined) {
      return `LIMIT ${offset}, ${limit}`;
    }
    return `LIMIT ${limit}`;
  }
}

// 注册驱动
registerDriver('mysql', MySQLDriver as any);