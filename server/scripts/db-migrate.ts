/**
 * 数据库迁移脚本（测试用）
 */

import { loadEnv } from '../src/config/env';

// 必须先加载 .env，再碰任何数据库配置：否则 DB_TYPE/DB_PATH 全部走默认值，
// CI 的 sqlite/postgresql/mysql 矩阵会全部退化成同一个 sqlite 默认库。
loadEnv();

import { connect, getConnection, disconnect } from '../src/db/connection';
import { log } from './_logger-compat';

const migrations = [
  {
    version: 1,
    name: 'create_test_table',
    up: `
      CREATE TABLE IF NOT EXISTS migration_test (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        created_at TEXT
      )
    `,
    down: `DROP TABLE IF EXISTS migration_test`
  },
  {
    version: 2,
    name: 'add_test_column',
    up: `ALTER TABLE migration_test ADD COLUMN description TEXT`,
    down: `` // SQLite不支持删除列，需要重建表
  },
  {
    version: 3,
    name: 'create_index',
    up: `CREATE INDEX IF NOT EXISTS idx_migration_test_name ON migration_test(name)`,
    down: `DROP INDEX IF EXISTS idx_migration_test_name`
  }
];

async function runMigrations() {
  const mode = process.argv[2] || 'up';

  log.info('DBMigrate', `Running migrations: ${mode}`);

  try {
    await connect();
    const conn = getConnection();

    // 创建迁移记录表
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT,
        executed_at TEXT
      )
    `);

    if (mode === 'up') {
      // 向上迁移
      for (const migration of migrations) {
        const existing = await conn.get(
          'SELECT version FROM schema_migrations WHERE version = ?',
          [migration.version]
        );

        if (!existing) {
          log.info('DBMigrate', `Applying migration ${migration.version}: ${migration.name}`);

          if (migration.up) {
            await conn.execute(migration.up);
          }

          await conn.run(
            'INSERT INTO schema_migrations (version, name, executed_at) VALUES (?, ?, ?)',
            [migration.version, migration.name, new Date().toISOString()]
          );

          log.info('DBMigrate', `✓ Migration ${migration.version} applied`);
        } else {
          log.info('DBMigrate', `Migration ${migration.version} already applied`);
        }
      }
    } else if (mode === 'down') {
      // 向下迁移（回滚）
      const appliedMigrations = await conn.query(
        'SELECT version FROM schema_migrations ORDER BY version DESC'
      );

      for (const applied of appliedMigrations) {
        const migration = migrations.find(m => m.version === (applied as any).version);
        if (migration && migration.down) {
          log.info('DBMigrate', `Rolling back migration ${migration.version}: ${migration.name}`);

          await conn.execute(migration.down);

          await conn.run(
            'DELETE FROM schema_migrations WHERE version = ?',
            [migration.version]
          );

          log.info('DBMigrate', `✓ Migration ${migration.version} rolled back`);
        }
      }
    }

    // 显示当前迁移状态
    const currentMigrations = await conn.query(
      'SELECT version, name, executed_at FROM schema_migrations ORDER BY version'
    );

    log.info('DBMigrate', `Current schema version: ${currentMigrations.length}`);
    for (const m of currentMigrations) {
      log.info('DBMigrate', `  - v${(m as any).version}: ${(m as any).name} (${(m as any).executed_at})`);
    }

    log.info('DBMigrate', 'Migrations completed successfully!');

    await disconnect();
    process.exit(0);
  } catch (error) {
    log.error('DBMigrate', 'Migration failed', error);
    await disconnect().catch(() => {});
    process.exit(1);
  }
}

runMigrations();
