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
