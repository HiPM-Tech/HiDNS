/**
 * 数据库核心类型定义
 * 提供统一的数据库类型系统，支持 MySQL、PostgreSQL 和 SQLite
 */

import type { Pool as MySQLPool } from 'mysql2/promise';
import type { Pool as PostgreSQLPool } from 'pg';
import type { DatabaseSync } from 'node:sqlite';

/** 支持的数据库类型 */
export type DatabaseType = 'sqlite' | 'mysql' | 'postgresql';

/** 查询操作符 */
export type Operator = '=' | '!=' | '<>' | '<' | '<=' | '>' | '>=' | 'LIKE' | 'NOT LIKE' | 'IN' | 'NOT IN' | 'IS' | 'IS NOT' | 'BETWEEN';

/** 排序方向 */
export type OrderDirection = 'asc' | 'desc';

/** 连接类型 */
export type JoinType = 'inner' | 'left' | 'right' | 'full';

/** 原始数据库连接类型 */
export type RawConnection = MySQLPool | PostgreSQLPool | DatabaseSync;

/** 事务接口 */
export interface Transaction {
  /**
   * 归还底层连接。连接池驱动（postgresql / mysql）必须实现：
   * 不归还会让连接被永久占住，池耗尽后所有查询挂起、close() 也永不返回。
   */
  done?: () => void | Promise<void>;
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined>;
  execute(sql: string, params?: unknown[]): Promise<void>;
  insert(sql: string, params?: unknown[]): Promise<number>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

/** 数据库连接接口 */
export interface DatabaseConnection {
  readonly type: DatabaseType;
  readonly isConnected: boolean;

  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined>;
  execute(sql: string, params?: unknown[]): Promise<void>;
  insert(sql: string, params?: unknown[]): Promise<number>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;

  beginTransaction(): Promise<Transaction>;

  raw(): RawConnection;
  close(): Promise<void>;
  checkpoint?(): Promise<void>;

  /** 获取连接统计信息（查询数、错误数等） */
  getStats(): import('../dl/types').ConnectionStats;
  /** 获取 IO 统计信息（目前仅 SQLite 有效） */
  getIoStats(): { reads: number; writes: number };
}

/** 列类型定义 */
export type ColumnType =
  | 'string'
  | 'text'
  | 'integer'
  | 'bigint'
  | 'decimal'
  | 'boolean'
  | 'datetime'
  | 'timestamp'
  | 'date'
  | 'json'
  | 'uuid'
  | 'serial';

/** 列定义 */
export interface ColumnDefinition {
  name: string;
  type: ColumnType;
  nullable: boolean;
  primary?: boolean;
  unique?: boolean;
  default?: unknown;
  autoIncrement?: boolean;
  length?: number;
  precision?: number;
  scale?: number;
}

/** 表定义 */
export interface TableDefinition {
  name: string;
  columns: ColumnDefinition[];
  indexes?: IndexDefinition[];
  primaryKey?: string[];
}

/** 索引定义 */
export interface IndexDefinition {
  name: string;
  columns: string[];
  unique?: boolean;
}

/** 查询条件 */
export interface WhereCondition {
  column: string;
  operator: Operator;
  value: unknown;
  boolean: 'and' | 'or';
}

/** 连接条件 */
export interface JoinCondition {
  type: JoinType;
  table: string;
  on: {
    left: string;
    operator: Operator;
    right: string;
  }[];
}

/** 排序定义 */
export interface OrderBy {
  column: string;
  direction: OrderDirection;
}

/** 查询构建器状态 */
export interface QueryState {
  table?: string;
  columns: string[];
  where: WhereCondition[];
  joins: JoinCondition[];
  orderBy: OrderBy[];
  limit?: number;
  offset?: number;
  distinct: boolean;
}

/** 编译后的 SQL */
export interface CompiledSQL {
  sql: string;
  params: unknown[];
}

/** 插入查询 */
export interface InsertQuery {
  table: string;
  data: Record<string, unknown>;
  returning?: string[];
}

/** 批量插入查询 */
export interface BatchInsertQuery {
  table: string;
  data: Record<string, unknown>[];
  returning?: string[];
}

/** 更新查询 */
export interface UpdateQuery {
  table: string;
  data: Record<string, unknown>;
  where: WhereCondition[];
  returning?: string[];
}

/** 删除查询 */
export interface DeleteQuery {
  table: string;
  where: WhereCondition[];
  returning?: string[];
}

/** 选择查询 */
export interface SelectQuery {
  table: string;
  columns: string[];
  where: WhereCondition[];
  joins: JoinCondition[];
  orderBy: OrderBy[];
  limit?: number;
  offset?: number;
  distinct: boolean;
}

/** MySQL 保留关键字集合 */
export const MYSQL_RESERVED_KEYWORDS = new Set([
  'accessible', 'add', 'all', 'alter', 'analyze', 'and', 'as', 'asc',
  'asensitive', 'before', 'between', 'bigint', 'binary', 'blob', 'both',
  'by', 'call', 'cascade', 'case', 'change', 'char', 'character', 'check',
  'collate', 'column', 'condition', 'constraint', 'continue', 'convert',
  'create', 'cross', 'cube', 'cume_dist', 'current_date', 'current_time',
  'current_timestamp', 'current_user', 'cursor', 'database', 'databases',
  'day_hour', 'day_microsecond', 'day_minute', 'day_second', 'dec', 'decimal',
  'declare', 'default', 'delayed', 'delete', 'dense_rank', 'desc', 'describe',
  'deterministic', 'distinct', 'distinctrow', 'div', 'double', 'drop', 'dual',
  'each', 'else', 'elseif', 'empty', 'enclosed', 'escaped', 'except', 'exists',
  'exit', 'explain', 'false', 'fetch', 'first_value', 'float', 'float4',
  'float8', 'for', 'force', 'foreign', 'from', 'fulltext', 'function',
  'generated', 'get', 'grant', 'group', 'grouping', 'groups', 'having',
  'high_priority', 'hour_microsecond', 'hour_minute', 'hour_second', 'if',
  'ignore', 'in', 'index', 'infile', 'inner', 'inout', 'insensitive', 'insert',
  'int', 'int1', 'int2', 'int3', 'int4', 'int8', 'integer', 'interval', 'into',
  'io_thread', 'is', 'iterate', 'join', 'json_table', 'key', 'keys', 'kill',
  'lag', 'last_value', 'lateral', 'lead', 'leading', 'leave', 'left', 'like',
  'limit', 'linear', 'lines', 'load', 'localtime', 'localtimestamp', 'lock',
  'long', 'longblob', 'longtext', 'loop', 'low_priority', 'master_bind',
  'master_ssl_verify_server_cert', 'match', 'maxvalue', 'mediumblob',
  'mediumint', 'mediumtext', 'middleint', 'minute_microsecond', 'minute_second',
  'mod', 'modifies', 'natural', 'not', 'no_write_to_binlog', 'nth_value',
  'ntile', 'null', 'numeric', 'of', 'on', 'optimize', 'optimizer_costs',
  'option', 'optionally', 'or', 'order', 'out', 'outer', 'outfile', 'over',
  'partition', 'percent_rank', 'precision', 'primary', 'procedure', 'purge',
  'range', 'rank', 'read', 'reads', 'read_write', 'real', 'recursive',
  'references', 'regexp', 'release', 'rename', 'repeat', 'replace', 'require',
  'resignal', 'restrict', 'return', 'revoke', 'right', 'rlike', 'row',
  'rows', 'row_number', 'schema', 'schemas', 'second_microsecond', 'select',
  'sensitive', 'separator', 'set', 'show', 'signal', 'smallint', 'spatial',
  'specific', 'sql', 'sqlexception', 'sqlstate', 'sqlwarning', 'sql_big_result',
  'sql_calc_found_rows', 'sql_small_result', 'ssl', 'starting', 'stored',
  'straight_join', 'system', 'table', 'terminated', 'then', 'tinyblob',
  'tinyint', 'tinytext', 'to', 'trailing', 'trigger', 'true', 'undo', 'union',
  'unique', 'unlock', 'unsigned', 'update', 'usage', 'use', 'using', 'utc_date',
  'utc_time', 'utc_timestamp', 'values', 'varbinary', 'varchar', 'varcharacter',
  'varying', 'virtual', 'when', 'where', 'while', 'window', 'with', 'write',
  'xor', 'year_month', 'zerofill'
]);

/** PostgreSQL 保留关键字集合 */
export const POSTGRESQL_RESERVED_KEYWORDS = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc',
  'asymmetric', 'both', 'case', 'cast', 'check', 'collate', 'column',
  'constraint', 'create', 'current_catalog', 'current_date', 'current_role',
  'current_time', 'current_timestamp', 'current_user', 'default', 'deferrable',
  'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch', 'for',
  'foreign', 'from', 'grant', 'group', 'having', 'in', 'initially',
  'intersect', 'into', 'lateral', 'leading', 'limit', 'localtime',
  'localtimestamp', 'not', 'null', 'offset', 'on', 'only', 'or', 'order',
  'placing', 'primary', 'references', 'returning', 'select', 'session_user',
  'some', 'symmetric', 'table', 'then', 'to', 'trailing', 'true', 'union',
  'unique', 'user', 'using', 'variadic', 'when', 'where', 'window', 'with'
]);

/** SQLite 保留关键字集合 */
export const SQLITE_RESERVED_KEYWORDS = new Set([
  'abort', 'action', 'add', 'after', 'all', 'alter', 'analyze', 'and', 'as',
  'asc', 'attach', 'autoincrement', 'before', 'begin', 'between', 'by',
  'cascade', 'case', 'cast', 'check', 'collate', 'column', 'commit',
  'conflict', 'constraint', 'create', 'cross', 'current_date', 'current_time',
  'current_timestamp', 'database', 'default', 'deferrable', 'deferred',
  'delete', 'desc', 'detach', 'distinct', 'drop', 'each', 'else', 'end',
  'escape', 'except', 'exclusive', 'exists', 'explain', 'fail', 'for',
  'foreign', 'from', 'full', 'glob', 'group', 'having', 'if', 'ignore',
  'immediate', 'in', 'index', 'indexed', 'initially', 'inner', 'insert',
  'instead', 'intersect', 'into', 'is', 'isnull', 'join', 'key', 'left',
  'like', 'limit', 'match', 'natural', 'no', 'not', 'notnull', 'null', 'of',
  'offset', 'on', 'or', 'order', 'outer', 'plan', 'pragma', 'primary', 'query',
  'raise', 'recursive', 'references', 'regexp', 'reindex', 'release', 'rename',
  'replace', 'restrict', 'right', 'rollback', 'row', 'savepoint', 'select',
  'set', 'table', 'temp', 'temporary', 'then', 'to', 'transaction', 'trigger',
  'union', 'unique', 'update', 'using', 'vacuum', 'values', 'view', 'virtual',
  'when', 'where', 'with', 'without'
]);