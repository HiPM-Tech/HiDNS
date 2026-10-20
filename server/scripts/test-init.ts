/**
 * 测试数据库初始化
 * 测试场景：
 * 1. 全新环境初始化
 * 2. 已有数据环境初始化
 * 3. 删除.env后重新初始化
 */

import { loadEnv } from '../src/config/env';

// 必须先加载 .env，再碰任何数据库配置：否则 DB_TYPE/DB_PATH 全部走默认值，
// CI 的 sqlite/postgresql/mysql 矩阵会全部退化成同一个 sqlite 默认库。
loadEnv();

import { connect, getConnection, disconnect, isDbInitialized } from '../src/db/connection';
import { initializeDSM } from '../src/db/dsm/init-dsm';
import { log } from './_logger-compat';

async function testInit() {
  log.info('TestInit', 'Starting database initialization test');

  try {
    // 测试1: 检查数据库连接
    log.info('TestInit', 'Test 1: Checking database connection');
    await connect();
    log.info('TestInit', '✓ Database connection successful');

    const conn = getConnection();

    // 测试2: 初始化数据库
    log.info('TestInit', 'Test 2: Initializing database');
    await initializeDSM();
    log.info('TestInit', '✓ Database initialized');

    // 测试3: 验证表结构
    log.info('TestInit', 'Test 3: Verifying table structure');
    const type = conn.type;
    let tables: any[] = [];

    if (type === 'sqlite') {
      tables = await conn.query("SELECT name FROM sqlite_master WHERE type='table'");
    } else if (type === 'mysql') {
      tables = await conn.query("SELECT TABLE_NAME as name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
    } else if (type === 'postgresql') {
      tables = await conn.query("SELECT tablename as name FROM pg_tables WHERE schemaname = 'public'");
    }

    const requiredTables = ['users', 'domains', 'dns_accounts', 'system_settings', 'operation_logs'];
    const existingTables = tables.map((t: any) => t.name);

    for (const table of requiredTables) {
      if (!existingTables.includes(table)) {
        throw new Error(`Required table '${table}' not found`);
      }
    }
    log.info('TestInit', '✓ All required tables exist');

    // 测试4: 验证初始化状态
    log.info('TestInit', 'Test 4: Verifying initialization status');
    const initialized = await isDbInitialized();
    if (!initialized) {
      throw new Error('Database initialization status check failed');
    }
    log.info('TestInit', '✓ Database initialization status verified');

    log.info('TestInit', 'All initialization tests passed!');

    // 断开连接
    await disconnect();
    process.exit(0);
  } catch (error) {
    log.error('TestInit', 'Initialization test failed', error);
    await disconnect().catch(() => {});
    process.exit(1);
  }
}

testInit();
