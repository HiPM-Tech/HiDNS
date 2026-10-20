/**
 * 测试数据种子（用于验证数据持久化生命周期）
 *
 * 表结构以 `src/db/dsm/schemas/complete-schema.ts` 为准：
 *   users(nickname/role/role_level 均 NOT NULL) → dns_accounts → domains(account_id, name) → dns_records
 *   设置表是 `system_settings(key, value, updated_at)`，不再是 `settings`。
 * 脚本可重复执行：每次先清掉上一轮的种子数据。
 */

import { loadEnv } from '../src/config/env';

// 必须先加载 .env，再碰任何数据库配置：否则 DB_TYPE/DB_PATH 全部走默认值，
// CI 的 sqlite/postgresql/mysql 矩阵会全部退化成同一个 sqlite 默认库。
loadEnv();

import bcrypt from 'bcryptjs';
import { connect, getConnection, disconnect } from '../src/db/connection';
import { log } from './_logger-compat';
import { quoteIdent, sqlNow } from './_ddl-compat';

const TEST_USERNAME = 'testuser';
const TEST_DOMAIN = 'test-example.com';

async function testSeed() {
  log.info('TestSeed', 'Starting test data seeding');

  try {
    await connect();
    const conn = getConnection();
    const now = sqlNow();
    const keyCol = quoteIdent(conn.type, 'key');

    // 幂等：清掉上一轮种子（按依赖顺序）
    const existingUser = await conn.get('SELECT id FROM users WHERE username = ?', [TEST_USERNAME]) as
      | { id: number }
      | undefined;
    if (existingUser) {
      const oldDomains = await conn.query('SELECT id FROM domains WHERE name = ?', [TEST_DOMAIN]);
      for (const d of oldDomains as Array<{ id: number }>) {
        await conn.run('DELETE FROM dns_records WHERE domain_id = ?', [d.id]);
        await conn.run('DELETE FROM domains WHERE id = ?', [d.id]);
      }
      const oldAccounts = await conn.query('SELECT id FROM dns_accounts WHERE created_by = ?', [existingUser.id]);
      for (const a of oldAccounts as Array<{ id: number }>) {
        await conn.run('DELETE FROM dns_accounts WHERE id = ?', [a.id]);
      }
      await conn.run('DELETE FROM users WHERE id = ?', [existingUser.id]);
    }

    log.info('TestSeed', 'Creating test user');
    const hashedPassword = await bcrypt.hash('testpassword123', 10);
    const userId = await conn.insert(
      `INSERT INTO users (username, nickname, email, password_hash, role, role_level, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [TEST_USERNAME, 'Test User', 'test@example.com', hashedPassword, 'admin', 2, 1, now, now],
    );
    log.info('TestSeed', `✓ Created test user with ID: ${userId}`);

    log.info('TestSeed', 'Creating test DNS account');
    const accountId = await conn.insert(
      `INSERT INTO dns_accounts (type, name, config, remark, enabled, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['dnspod', 'Seed Account', JSON.stringify({}), 'lifecycle seed', 1, userId, now],
    );
    log.info('TestSeed', `✓ Created test DNS account with ID: ${accountId}`);

    log.info('TestSeed', 'Creating test domain');
    const domainId = await conn.insert(
      `INSERT INTO domains (account_id, name, third_id, remark, is_hidden, enabled, record_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [accountId, TEST_DOMAIN, '', 'lifecycle seed', 0, 1, 0, now],
    );
    log.info('TestSeed', `✓ Created test domain with ID: ${domainId}`);

    log.info('TestSeed', 'Creating test DNS records');
    const records = [
      { name: '@', type: 'A', value: '192.0.2.1', ttl: 600 },
      { name: 'www', type: 'A', value: '192.0.2.2', ttl: 600 },
      { name: 'mail', type: 'MX', value: '10 mail.test-example.com', ttl: 3600 },
    ];
    for (const record of records) {
      await conn.run(
        `INSERT INTO dns_records (domain_id, record_type, name, value, ttl, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [domainId, record.type, record.name, record.value, record.ttl, 'active', now, now],
      );
    }
    await conn.run('UPDATE domains SET record_count = ? WHERE id = ?', [records.length, domainId]);
    log.info('TestSeed', `✓ Created ${records.length} test DNS records`);

    log.info('TestSeed', 'Creating test settings');
    // 幂等：system_settings.key 是 UNIQUE，重跑前先清掉上一轮的键
    await conn.run(`DELETE FROM system_settings WHERE ${keyCol} IN ('test_setting', 'test_data_ids')`);
    const insertSetting = `INSERT INTO system_settings (${keyCol}, value, updated_at) VALUES (?, ?, ?)`;
    await conn.run(insertSetting, ['test_setting', JSON.stringify({ test: true, timestamp: Date.now() }), now]);
    await conn.run(insertSetting, ['test_data_ids', JSON.stringify({ userId, accountId, domainId }), now]);
    log.info('TestSeed', '✓ Created test settings');

    log.info('TestSeed', 'All test data seeded successfully!');
    await disconnect();
    process.exit(0);
  } catch (error) {
    log.error('TestSeed', 'Failed to seed test data', error);
    await disconnect().catch(() => {});
    process.exit(1);
  }
}

testSeed();
