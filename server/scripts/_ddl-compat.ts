import type { DatabaseType } from '../src/db/dal/types';

/**
 * 测试脚本用的建表语句：SQL 方言不同，不能只写 SQLite 的 AUTOINCREMENT。
 * 之前 CI 的数据库矩阵里 pg/mysql 从未真正跑过，所以这个方言差异一直没暴露。
 */
export function autoIdColumn(type: DatabaseType): string {
  switch (type) {
    case 'postgresql':
      return 'id SERIAL PRIMARY KEY';
    case 'mysql':
      return 'id INT AUTO_INCREMENT PRIMARY KEY';
    default:
      return 'id INTEGER PRIMARY KEY AUTOINCREMENT';
  }
}

export function dropTableSql(name: string): string {
  return `DROP TABLE IF EXISTS ${name}`;
}

/** 标识符引用：MySQL/SQLite 用反引号，PostgreSQL 用双引号。`key` 在 MySQL 里是保留字。 */
export function quoteIdent(type: DatabaseType, name: string): string {
  return type === 'postgresql' ? `"${name}"` : `\`${name}\``;
}

/** DATETIME 列的写入值：toISOString() 带 T 和 Z，MySQL 会报 Incorrect datetime value。 */
export function sqlNow(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

