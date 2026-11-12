import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getConnection } from '../src/db/connection';
import { DnsAccountOperations } from '../src/db/bal/business-adapter';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

/**
 * 集成测试：删除账号时的级联清理。
 *
 * 用真实的 DSM 建出来的库（不是手写 CREATE TABLE），因此能暴露表名/列名对不上的问题——
 * 之前手写 SQL 里用了不存在的 `records` 表，正是这类问题。
 */
let handle: TestDbHandle;

async function lastId(): Promise<number> {
  const row = await getConnection().get<{ id: number }>('SELECT last_insert_rowid() AS id');
  return Number((row as { id: number } | undefined)?.id ?? 0);
}

async function seedAccount(tag: string) {
  const conn = getConnection();
  const user = await conn.run(
    'INSERT INTO users (username, email, password_hash, role_level, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [`u-${tag}`, `${tag}@example.com`, 'hash', 1, 1, new Date().toISOString()],
  );
  void user;
  const userId = await lastId();

  const account = await conn.run(
    'INSERT INTO dns_accounts (type, name, config, remark, created_by, team_id, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ['spaceship', `acc-${tag}`, '{}', '', userId, null, 1, new Date().toISOString()],
  );
  void account;
  const accountId = await lastId();

  const domain = await conn.run(
    'INSERT INTO domains (account_id, name, remark) VALUES (?, ?, ?)',
    [accountId, `${tag}.example.com`, ''],
  );
  void domain;
  const domainId = await lastId();

  await conn.run(
    'INSERT INTO dns_records (domain_id, record_type, name, value) VALUES (?, ?, ?, ?)',
    [domainId, 'A', 'www', '1.1.1.1'],
  );
  await conn.run('INSERT INTO domain_permissions (domain_id, user_id) VALUES (?, ?)', [domainId, userId]);
  await conn.run(
    'INSERT INTO renewable_domains (account_id, provider_type, domain_name, full_domain) VALUES (?, ?, ?, ?)',
    [accountId, 'spaceship', `${tag}.example.com`, `${tag}.example.com`],
  );

  return { userId, accountId, domainId };
}

async function countRows(table: string, where: string, params: unknown[]): Promise<number> {
  const rows = await getConnection().query<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM ${table} WHERE ${where}`, params);
  return Number(rows[0]?.cnt ?? 0);
}

describe('删除账号级联清理（集成）', () => {
  beforeAll(async () => { handle = await setupTestDb(); });
  afterAll(async () => { await handle.cleanup(); });

  it('同一事务内清掉域名、记录、权限与续期数据', async () => {
    const { userId, accountId, domainId } = await seedAccount('cascade');

    const result = await DnsAccountOperations.deleteWithCascade(accountId);

    expect(result.domains).toBe(1);
    expect(result.renewable).toBe(1);
    expect(await countRows('dns_accounts', 'id = ?', [accountId])).toBe(0);
    expect(await countRows('domains', 'id = ?', [domainId])).toBe(0);
    expect(await countRows('dns_records', 'domain_id = ?', [domainId])).toBe(0);
    expect(await countRows('domain_permissions', 'domain_id = ?', [domainId])).toBe(0);
    expect(await countRows('renewable_domains', 'account_id = ?', [accountId])).toBe(0);

    // 账号本身删掉后，该用户仍是正常的（只删关联数据）
    expect(await countRows('users', 'id = ?', [userId])).toBe(1);
  });

  it('只清理目标账号的数据，不影响其它账号', async () => {
    const keep = await seedAccount('keep');
    const drop = await seedAccount('drop');

    await DnsAccountOperations.deleteWithCascade(drop.accountId);

    expect(await countRows('domains', 'account_id = ?', [keep.accountId])).toBe(1);
    expect(await countRows('dns_records', 'domain_id = ?', [keep.domainId])).toBe(1);
    expect(await countRows('renewable_domains', 'account_id = ?', [keep.accountId])).toBe(1);
  });

  it('账号不存在时返回 0 且不抛错', async () => {
    const result = await DnsAccountOperations.deleteWithCascade(999999);
    expect(result).toEqual({ domains: 0, renewable: 0 });
  });
});