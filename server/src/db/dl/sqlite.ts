/**
 * SQLite 数据库驱动 (node:sqlite)
 * 使用 Node.js 24+ 内置的 node:sqlite 模块替代 better-sqlite3
 */

import type { Transaction, ColumnType } from '../dal/types';
import type { DriverConfig } from './types';
import { BaseDriver } from './base';
import { registerDriver } from './types';
import { guardOutsideTransaction } from '../dal/tx-gate';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { createLogger } from '../../lib/logger';

const log = createLogger('DL').sub('Sqlite');

/** SQLite run 方法返回类型 */
type RunResult = { changes: number };

/** SQLite 配置 */
export interface SQLiteDriverConfig {
  path: string;
  mode?: 'readwrite' | 'readonly' | 'create';
  busyTimeout?: number;
  enableWAL?: boolean;
  foreignKeys?: boolean;
}

/** 将参数中的 Date 对象转换为 Unix 时间戳（秒） */
function serializeParams(params: unknown[]): unknown[] {
  return params.map(p => p instanceof Date ? Math.floor(p.getTime() / 1000) : p);
}

/** SQLite 驱动实现 */
export class SQLiteDriver extends BaseDriver {
  readonly type = 'sqlite' as const;
  private db: DatabaseSync | null = null;
  private connectionConfig: SQLiteDriverConfig;
  ioReads = 0
  ioWrites = 0

  constructor(config: SQLiteDriverConfig, driverConfig?: DriverConfig) {
    super(driverConfig);
    this.connectionConfig = config;

    try {
      // 确保目录存在
      const dir = path.dirname(config.path);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      log.info('Opening database', { path: config.path });

      // 使用 node:sqlite 内置模块 (Node.js 24+)
      // DatabaseSync 是同步接口，无需外部依赖，完美支持 SEA 打包
      this.db = new DatabaseSync(config.path);
      log.info('Database opened successfully');

      // 配置 SQLite (使用 exec 执行 PRAGMA，node:sqlite 的 DatabaseSync 没有独立的 pragma 方法)
      if (config.enableWAL !== false) {
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = NORMAL');
      }
      if (config.foreignKeys !== false) {
        this.db.exec('PRAGMA foreign_keys = ON');
      }
      if (config.busyTimeout) {
        this.db.exec(`PRAGMA busy_timeout = ${config.busyTimeout}`);
      }
    } catch (error) {
      log.error('Failed to open database', { path: config.path, error });
      throw error;
    }
  }

  get isConnected(): boolean {
    return this.db !== null;
  }

  async query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
    await guardOutsideTransaction();
    return this.executeWithSlowQueryCheck('SQLite.query', sql, params, async () => {
      this._stats.queries++;
      try {
        const stmt = this.db!.prepare(sql);
        const sqlUpper = sql.trim().toLowerCase();
        if (sqlUpper.startsWith('select') || sqlUpper.startsWith('pragma') || sqlUpper.startsWith('explain')) {
          this.ioReads++
          return stmt.all(...serializeParams(params || [])) as T[];
        }
        this.ioWrites++
        stmt.run(...serializeParams(params || []));
        return [];
      } catch (error) {
        this._stats.errors++;
        log.error('Query error', { sql: sql.substring(0, 100), error });
        throw error;
      }
    });
  }

  async get<T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined> {
    await guardOutsideTransaction();
    return this.executeWithSlowQueryCheck('SQLite.get', sql, params, async () => {
      this._stats.queries++;
      try {
        const stmt = this.db!.prepare(sql);
        this.ioReads++
        return stmt.get(...serializeParams(params || [])) as T | undefined;
      } catch (error) {
        this._stats.errors++;
        log.error('Get error', { sql: sql.substring(0, 100), error });
        throw error;
      }
    });
  }

  async execute(sql: string, params?: unknown[]): Promise<void> {
    await guardOutsideTransaction();
    return this.executeWithSlowQueryCheck('SQLite.execute', sql, params, async () => {
      this._stats.queries++;
      try {
        const stmt = this.db!.prepare(sql);
        const sqlUpper = sql.trim().toLowerCase()
        if (sqlUpper.startsWith('select') || sqlUpper.startsWith('pragma') || sqlUpper.startsWith('explain') || sqlUpper.startsWith('begin') || sqlUpper.startsWith('commit') || sqlUpper.startsWith('rollback')) {
          this.ioReads++
        } else {
          this.ioWrites++
        }
        stmt.run(...serializeParams(params || []));
      } catch (error) {
        this._stats.errors++;
        log.error('Execute error', { sql: sql.substring(0, 100), error });
        throw error;
      }
    });
  }

  async insert(sql: string, params?: unknown[]): Promise<number> {
    this.ioWrites++
    const stmt = this.db!.prepare(sql);
    const result = stmt.run(...serializeParams(params || []));
    return Number(result.lastInsertRowid);
  }

  async run(sql: string, params?: unknown[]): Promise<RunResult> {
    await guardOutsideTransaction();
    this.ioWrites++
    const stmt = this.db!.prepare(sql);
    const result = stmt.run(...serializeParams(params || []));
    return { changes: result.changes };
  }

  async beginTransaction(): Promise<Transaction> {
    this.db!.exec('BEGIN TRANSACTION');

    return {
      query: async <T = unknown>(sql: string, params?: unknown[]): Promise<T[]> => {
        const stmt = this.db!.prepare(sql);
        if (sql.trim().toLowerCase().startsWith('select')) {
          return stmt.all(...serializeParams(params || [])) as T[];
        }
        stmt.run(...serializeParams(params || []));
        return [];
      },
      get: async <T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined> => {
        const stmt = this.db!.prepare(sql);
        return stmt.get(...serializeParams(params || [])) as T | undefined;
      },
      execute: async (sql: string, params?: unknown[]): Promise<void> => {
        const stmt = this.db!.prepare(sql);
        stmt.run(...serializeParams(params || []));
      },
      insert: async (sql: string, params?: unknown[]): Promise<number> => {
        const stmt = this.db!.prepare(sql);
        const result = stmt.run(...serializeParams(params || []));
        return Number(result.lastInsertRowid);
      },
      run: async (sql: string, params?: unknown[]): Promise<RunResult> => {
        const stmt = this.db!.prepare(sql);
        const result = stmt.run(...serializeParams(params || []));
        return { changes: result.changes };
      },
    };
  }

  raw(): DatabaseSync | null {
    return this.db;
  }

  /** 强制 WAL checkpoint，将 WAL 内容写入主数据库文件 */
  async checkpoint(): Promise<void> {
    if (this.db) {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }
  }

  async close(): Promise<void> {
    log.info('Closing database', { stats: this._stats });
    if (this.db) {
      try {
        await this.checkpoint();
      } catch (e) {
        log.warn('WAL checkpoint failed during close', { error: e });
      }
      this.db.close();
      this.db = null;
    }
  }

  // ==================== SQL 方言 ====================

  escapeIdentifier(name: string): string {
    return `"${name}"`;
  }

  placeholder(): string {
    return '?';
  }

  mapType(type: ColumnType, options?: { length?: number; precision?: number; scale?: number }): string {
    switch (type) {
      case 'string':
        return 'TEXT';
      case 'text':
        return 'TEXT';
      case 'integer':
        return 'INTEGER';
      case 'bigint':
        return 'INTEGER';
      case 'decimal':
        return 'REAL';
      case 'boolean':
        return 'INTEGER';
      case 'datetime':
        return 'TEXT';
      case 'timestamp':
        return 'TEXT';
      case 'date':
        return 'TEXT';
      case 'json':
        return 'TEXT';
      case 'uuid':
        return 'TEXT';
      case 'serial':
        return 'INTEGER PRIMARY KEY AUTOINCREMENT';
      default:
        return 'TEXT';
    }
  }

  now(): string {
    return "datetime('now')";
  }

  dateDiff(a: string, b: string): string {
    return `julianday(${a}) - julianday(${b})`;
  }

  limitOffset(limit: number, offset?: number): string {
    if (offset !== undefined) {
      return `LIMIT ${limit} OFFSET ${offset}`;
    }
    return `LIMIT ${limit}`;
  }
}

// 注册驱动
registerDriver('sqlite', SQLiteDriver as any);