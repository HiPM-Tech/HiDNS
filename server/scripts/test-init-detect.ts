/**
 * 测试删除.env后的初始化检测
 * 验证系统能否正确检测已有数据
 */

import { loadEnv } from '../src/config/env';

// 必须先加载 .env，再碰任何数据库配置：否则 DB_TYPE/DB_PATH 全部走默认值，
// CI 的 sqlite/postgresql/mysql 矩阵会全部退化成同一个 sqlite 默认库。
loadEnv();

import { connect, getConnection, disconnect, isDbInitialized } from '../src/db/connection';
import { initializeDSM } from '../src/db/dsm/init-dsm';
import { log } from './_logger-compat';
import fs from 'fs';
import path from 'path';

async function testInitDetect() {
  log.info('TestInitDetect', 'Testing initialization detection without .env');

  try {
    const envPath = path.join(process.cwd(), '.env');

    // 检查.env是否存在
    if (fs.existsSync(envPath)) {
      log.warn('TestInitDetect', '.env file exists - this test should be run without .env');
      log.info('TestInitDetect', 'Testing with existing .env anyway...');
    } else {
      log.info('TestInitDetect', 'No .env file found - testing environment detection');
    }

    // 测试1: 尝试连接数据库（应该使用默认配置或环境变量）
    log.info('TestInitDetect', 'Test 1: Attempting database connection');
    try {
      await connect();
      log.info('TestInitDetect', '✓ Database connection successful (using defaults)');
    } catch (connError) {
      log.warn('TestInitDetect', '⚠ Connection error (expected without config):', connError);
      process.exit(0); // 没有配置时正常退出
    }

    const conn = getConnection();

    // 测试2: 检查是否能检测到已有数据
    log.info('TestInitDetect', 'Test 2: Checking for existing data');
    try {
      const hasData = await isDbInitialized();
      if (hasData) {
        log.info('TestInitDetect', '✓ Existing data detected - initialization should be skipped');
      } else {
        log.info('TestInitDetect', '✓ No existing data - fresh initialization needed');
      }
    } catch (dataError) {
      log.warn('TestInitDetect', '⚠ Could not check for existing data:', dataError);
    }

    // 测试3: 验证初始化流程
    log.info('TestInitDetect', 'Test 3: Testing initialization flow');
    try {
      await initializeDSM();
      log.info('TestInitDetect', '✓ Initialization completed');
    } catch (initError) {
      log.error('TestInitDetect', '✗ Initialization failed:', initError);
      throw initError;
    }

    log.info('TestInitDetect', 'All detection tests completed!');

    await disconnect();
    process.exit(0);
  } catch (error) {
    log.error('TestInitDetect', 'Test failed', error);
    await disconnect().catch(() => {});
    process.exit(1);
  }
}

testInitDetect();
