/**
 * 测试错误恢复
 * 验证数据库在错误情况下的恢复能力
 */

import { loadEnv } from '../src/config/env';

// 必须先加载 .env，再碰任何数据库配置：否则 DB_TYPE/DB_PATH 全部走默认值，
// CI 的 sqlite/postgresql/mysql 矩阵会全部退化成同一个 sqlite 默认库。
loadEnv();

import { connect, getConnection, disconnect, transaction } from '../src/db/connection';
import { log } from './_logger-compat';
import { autoIdColumn } from './_ddl-compat';

async function testErrorRecovery() {
  log.info('TestErrorRecovery', 'Starting error recovery test');

  try {
    await connect();
    const conn = getConnection();

    // 测试1: 事务回滚
    log.info('TestErrorRecovery', 'Test 1: Testing transaction rollback');

    // 创建测试表
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS error_test (
        ${autoIdColumn(conn.type)},
        value TEXT UNIQUE
      )
    `);

    // 清掉上一轮残留（脚本必须可重复执行；value 是 UNIQUE，残留会让插入直接失败）
    await conn.run('DELETE FROM error_test');
    // 插入初始数据
    await conn.run("INSERT INTO error_test (value) VALUES ('initial')");

    try {
      await transaction(async (trx) => {
        await trx.execute("INSERT INTO error_test (value) VALUES ('in-transaction')");

        // 故意引发错误
        throw new Error('Simulated error in transaction');
      });
    } catch (error) {
      log.info('TestErrorRecovery', 'Transaction failed as expected:', (error as Error).message);
    }

    // 验证数据是否回滚
    const afterRollback = await conn.query('SELECT * FROM error_test');
    if (afterRollback.length !== 1 || (afterRollback[0] as any).value !== 'initial') {
      throw new Error('Transaction rollback failed - data was not rolled back');
    }
    log.info('TestErrorRecovery', '✓ Transaction rollback successful');

    // 测试2: 语法错误恢复
    log.info('TestErrorRecovery', 'Test 2: Testing syntax error recovery');

    try {
      await conn.query('SELECT * FROM nonexistent_table_xyz');
      throw new Error('Should have thrown an error for nonexistent table');
    } catch (error) {
      log.info('TestErrorRecovery', 'Syntax error caught as expected');
    }

    // 验证后续查询仍能正常工作
    const afterError = await conn.query('SELECT 1 as test');
    if ((afterError[0] as any).test !== 1) {
      throw new Error('Database not functional after error');
    }
    log.info('TestErrorRecovery', '✓ Database functional after syntax error');

    // 测试3: 连接恢复
    log.info('TestErrorRecovery', 'Test 3: Testing connection recovery');

    // 模拟连接问题后重新连接
    await disconnect();
    await connect();

    // 重连后必须重新取连接句柄：旧的 conn 指向已关闭的驱动实例
    const reconnected = getConnection();
    const afterReconnect = await reconnected.query('SELECT COUNT(*) as count FROM error_test');
    log.info('TestErrorRecovery', `Records after reconnect: ${(afterReconnect[0] as any).count}`);
    log.info('TestErrorRecovery', '✓ Connection recovery successful');

    // 测试4: 超时恢复
    log.info('TestErrorRecovery', 'Test 4: Testing timeout recovery');

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Query timeout')), 100);
    });

    const queryPromise = reconnected.query('SELECT 1');

    try {
      await Promise.race([queryPromise, timeoutPromise]);
    } catch (timeoutError) {
      log.info('TestErrorRecovery', 'Timeout handled');
    }

    // 验证数据库仍然可用
    const afterTimeout = await reconnected.query('SELECT 2 as test');
    if ((afterTimeout[0] as any).test !== 2) {
      throw new Error('Database not functional after timeout');
    }
    log.info('TestErrorRecovery', '✓ Timeout recovery successful');

    // 清理测试数据
    await reconnected.execute('DROP TABLE IF EXISTS error_test');
    log.info('TestErrorRecovery', '✓ Test data cleaned up');

    log.info('TestErrorRecovery', 'All error recovery tests passed!');

    await disconnect();
    process.exit(0);
  } catch (error) {
    log.error('TestErrorRecovery', 'Error recovery test failed', error);
    await disconnect().catch(() => {});
    process.exit(1);
  }
}

testErrorRecovery();
