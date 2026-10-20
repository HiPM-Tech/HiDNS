/**
 * 测试并发连接
 * 验证数据库在高并发情况下的表现
 */

import { loadEnv } from '../src/config/env';

// 必须先加载 .env，再碰任何数据库配置：否则 DB_TYPE/DB_PATH 全部走默认值，
// CI 的 sqlite/postgresql/mysql 矩阵会全部退化成同一个 sqlite 默认库。
loadEnv();

import { connect, getConnection, disconnect } from '../src/db/connection';
import { log } from './_logger-compat';

async function testConcurrentConnections() {
  log.info('TestConcurrent', 'Starting concurrent connection test');

  const concurrentCount = 10;
  const operationsPerConnection = 5;

  try {
    await connect();
    const conn = getConnection();

    // 测试1: 并发查询
    log.info('TestConcurrent', `Test 1: Running ${concurrentCount} concurrent queries`);
    const queryPromises = [];

    for (let i = 0; i < concurrentCount; i++) {
      const promise = conn.query('SELECT ? as id, ? as timestamp', [i, Date.now()])
        .then((result: any) => {
          log.info('TestConcurrent', `Query ${i} completed:`, result[0]);
          return { success: true, id: i };
        })
        .catch((error: any) => {
          log.error('TestConcurrent', `Query ${i} failed:`, error);
          return { success: false, id: i, error };
        });

      queryPromises.push(promise);
    }

    const queryResults = await Promise.all(queryPromises);
    const successCount = queryResults.filter((r: any) => r.success).length;
    log.info('TestConcurrent', `✓ Concurrent queries: ${successCount}/${concurrentCount} succeeded`);

    if (successCount !== concurrentCount) {
      throw new Error(`Only ${successCount}/${concurrentCount} concurrent queries succeeded`);
    }

    // 测试2: 并发写入
    log.info('TestConcurrent', `Test 2: Running ${concurrentCount} concurrent writes`);

    // 创建测试表
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS concurrent_test (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER,
        sequence INTEGER,
        data TEXT,
        created_at TEXT
      )
    `);

    const writePromises = [];

    for (let i = 0; i < concurrentCount; i++) {
      const promise = (async () => {
        const results = [];
        for (let j = 0; j < operationsPerConnection; j++) {
          try {
            const insertId = await conn.insert(
              'INSERT INTO concurrent_test (thread_id, sequence, data, created_at) VALUES (?, ?, ?, ?)',
              [i, j, `Data from thread ${i}, seq ${j}`, new Date().toISOString()]
            );
            results.push({ success: true, insertId });
          } catch (error) {
            results.push({ success: false, error });
          }
        }
        return { threadId: i, results };
      })();

      writePromises.push(promise);
    }

    const writeResults = await Promise.all(writePromises);
    let totalWrites = 0;
    let successfulWrites = 0;

    for (const result of writeResults) {
      for (const op of (result as any).results) {
        totalWrites++;
        if (op.success) successfulWrites++;
      }
    }

    log.info('TestConcurrent', `✓ Concurrent writes: ${successfulWrites}/${totalWrites} succeeded`);

    if (successfulWrites !== totalWrites) {
      throw new Error(`Only ${successfulWrites}/${totalWrites} concurrent writes succeeded`);
    }

    // 测试3: 验证数据完整性
    log.info('TestConcurrent', 'Test 3: Verifying data integrity');
    const count = await conn.get('SELECT COUNT(*) as count FROM concurrent_test');
    const expectedCount = concurrentCount * operationsPerConnection;
    const actualCount = (count as any).count;

    log.info('TestConcurrent', `Expected ${expectedCount} records, found ${actualCount}`);

    if (actualCount !== expectedCount) {
      throw new Error(`Data integrity check failed: expected ${expectedCount}, got ${actualCount}`);
    }

    // 验证每个线程的数据
    const threadCounts = await conn.query(
      'SELECT thread_id, COUNT(*) as count FROM concurrent_test GROUP BY thread_id'
    );

    for (const tc of threadCounts as any[]) {
      if (tc.count !== operationsPerConnection) {
        throw new Error(`Thread ${tc.thread_id} has ${tc.count} records, expected ${operationsPerConnection}`);
      }
    }

    log.info('TestConcurrent', '✓ Data integrity verified');

    // 清理测试数据
    await conn.execute('DROP TABLE IF EXISTS concurrent_test');
    log.info('TestConcurrent', '✓ Test data cleaned up');

    log.info('TestConcurrent', 'All concurrent connection tests passed!');

    await disconnect();
    process.exit(0);
  } catch (error) {
    log.error('TestConcurrent', 'Concurrent test failed', error);
    await disconnect().catch(() => {});
    process.exit(1);
  }
}

testConcurrentConnections();
