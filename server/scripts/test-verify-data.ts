/**
 * 验证测试数据是否持久化（配合 test-seed 使用）
 *
 * 表结构以 `src/db/dsm/schemas/complete-schema.ts` 为准：
 *   域名列表是 `domains.name`（不是 domain），记录表是 `dns_records`，设置表是 `system_settings`。
 */

import { loadEnv } from '../src/config/env';

// 必须先加载 .env，再碰任何数据库配置：否则 DB_TYPE/DB_PATH 全部走默认值，
// CI 的 sqlite/postgresql/mysql 矩阵会全部退化成同一个 sqlite 默认库。
loadEnv();

import { connect, getConnection, disconnect } from '../src/db/connection';
import { log } from './_logger-compat';

async function testVerifyData() {
  log.info('TestVerify', 'Verifying test data persistence');

  try {
    await connect();
    const conn = getConnection();

    const settingsResult = await conn.get(
      "SELECT value FROM system_settings WHERE key = 'test_data_ids'",
    ) as { value?: string } | undefined;

    if (!settingsResult) {
      throw new Error('Test data IDs not found - data may not have been seeded');
    }

    const testIds = JSON.parse(String(settingsResult.value ?? '{}'));
    const { userId, accountId, domainId } = testIds;
    log.info('TestVerify', `Looking for user ID: ${userId}, domain ID: ${domainId}`);

    const user = await conn.get('SELECT id, username, email FROM users WHERE id = ?', [userId]) as
      | { id: number; username: string; email: string }
      | undefined;
    if (!user) {
      throw new Error(`Test user with ID ${userId} not found`);
    }
    log.info('TestVerify', `✓ User found: ${user.username} (${user.email})`);

    const account = await conn.get('SELECT id, type FROM dns_accounts WHERE id = ?', [accountId]) as
      | { id: number; type: string }
      | undefined;
    if (!account) {
      throw new Error(`Test DNS account with ID ${accountId} not found`);
    }
    log.info('TestVerify', `✓ DNS account found: #${account.id} (${account.type})`);

    const domain = await conn.get('SELECT id, name FROM domains WHERE id = ?', [domainId]) as
      | { id: number; name: string }
      | undefined;
    if (!domain) {
      throw new Error(`Test domain with ID ${domainId} not found`);
    }
    log.info('TestVerify', `✓ Domain found: ${domain.name}`);

    const records = await conn.query('SELECT COUNT(*) as count FROM dns_records WHERE domain_id = ?', [
      domainId,
    ]) as Array<{ count: number }>;
    const recordCount = Number(records[0]?.count ?? 0);
    if (recordCount === 0) {
      throw new Error('No DNS records found for test domain');
    }
    log.info('TestVerify', `✓ Found ${recordCount} DNS records`);

    const testSetting = await conn.get(
      "SELECT value FROM system_settings WHERE key = 'test_setting'",
    ) as { value?: string } | undefined;
    if (!testSetting) {
      throw new Error('Test setting not found');
    }
    const settingValue = JSON.parse(String(testSetting.value ?? '{}'));
    if (!settingValue.test) {
      throw new Error('Test setting value is invalid');
    }
    log.info('TestVerify', '✓ Test setting verified');

    // 写回一次，验证写路径同样持久化
    const updatedAt = new Date().toISOString();
    await conn.run('UPDATE system_settings SET value = ?, updated_at = ? WHERE key = ?', [
      JSON.stringify({ test: true, verified: true, timestamp: Date.now() }),
      updatedAt,
      'test_setting',
    ]);
    const reread = await conn.get("SELECT value FROM system_settings WHERE key = 'test_setting'") as { value?: string };
    if (!JSON.parse(String(reread.value ?? '{}')).verified) {
      throw new Error('Write-back to system_settings was not persisted');
    }
    log.info('TestVerify', '✓ Write path persisted');

    log.info('TestVerify', 'All test data verified successfully!');
    await disconnect();
    process.exit(0);
  } catch (error) {
    log.error('TestVerify', 'Data verification failed', error);
    await disconnect().catch(() => {});
    process.exit(1);
  }
}

testVerifyData();
