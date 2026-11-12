import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getConnection } from '../src/db/connection';
import { DnsAccountOperations } from '../src/db/bal/business-adapter';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

/**
 * 集成测试：删除账号时的级联清理。
 *
 * 用真实 DSM 建库（不是手写 CREATE TABLE），所以能暴露表名/列名对不上的问题；
 * 并且显式覆盖「外键不生效」与「中途失败」两种场景——真实 schema 自带 CASCADE，
 * 只用成功路径跑一遍的话，删掉显式清理甚至删掉事务都不会红（假绿）。
 */
let handle: TestDbHandle;

async function lastId(): Promise<number> {
  const row = await getConnection().get<{ id: number }>('SELECT last_insert_rowid() AS id');
  return Number((row as { id: number } | undefined)?.id ?? 0);
}

async function seedAccount(tag: string, options: { domainName?: string; monitor?: boolean } = {}) {
  const conn = getConnection();
  await conn.run(
    'INSERT INTO users (username, email, password_hash, role_level, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [`u-${tag}`, `${tag}@example.com`, 'hash', 1, 1, new Date().toISOString()],
  );
  const userId = await lastId();

  await conn.run(
    'INSERT INTO dns_accounts (type, name, config, remark, created_by, team_id, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ['spaceship', `acc-${tag}`, '{}', '', userId, null, 1, new Date().toISOString()],
  );
  const accountId = await lastId();

  const domainName = options.domainName ?? `${tag}.example.com`;
  await conn.run('INSERT INTO domains (account_id, name, remark) VALUES (?, ?, ?)', [accountId, domainName, '']);
  const domainId = await lastId();

  await conn.run(
    'INSERT INTO dns_records (domain_id, record_type, name, value) VALUES (?, ?, ?, ?)',
    [domainId, 'A', 'www', '1.1.1.1'],
  );
  await conn.run('INSERT INTO domain_permissions (domain_id, user_id) VALUES (?, ?)', [domainId, userId]);
  await conn.run(
    'INSERT INTO renewable_domains (account_id, provider_type, domain_name, full_domain) VALUES (?, ?, ?, ?)',
    [accountId, 'spaceship', domainName, domainName],
  );
  if (options.monitor !== false) {
    await conn.run('INSERT INTO ns_monitor_domains (user_id, domain_name) VALUES (?, ?)', [userId, domainName]);
  }

  return { userId, accountId, domainId, domainName };
}

async function countRows(table: string, where: string, params: unknown[]): Promise<number> {
  const rows = await getConnection().query<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM ${table} WHERE ${where}`, params);
  return Number(rows[0]?.cnt ?? 0);
}

describe('删除账号级联清理（集成）', () => {
  beforeAll(async () => { handle = await setupTestDb(); });
  afterEach(async () => {
    const conn = getConnection();
    await conn.execute('DROP TRIGGER IF EXISTS boom');
    await conn.execute('PRAGMA foreign_keys = ON');
  });
  afterAll(async () => { await handle.cleanup(); });

  it('同一事务内清掉域名、记录、权限、监控与续期数据', async () => {
    const { userId, accountId, domainId, domainName } = await seedAccount('cascade');

    const result = await DnsAccountOperations.deleteWithCascade(accountId);

    expect(result.domains).toBe(1);
    expect(result.renewable).toBe(1);
    expect(await countRows('dns_accounts', 'id = ?', [accountId])).toBe(0);
    expect(await countRows('domains', 'id = ?', [domainId])).toBe(0);
    expect(await countRows('dns_records', 'domain_id = ?', [domainId])).toBe(0);
    expect(await countRows('domain_permissions', 'domain_id = ?', [domainId])).toBe(0);
    expect(await countRows('renewable_domains', 'account_id = ?', [accountId])).toBe(0);
    expect(await countRows('ns_monitor_domains', 'domain_name = ?', [domainName])).toBe(0);
    // 用户本身保留
    expect(await countRows('users', 'id = ?', [userId])).toBe(1);
  });

  it('外键关闭（历史库）时依然清干净 —— 证明显式清理不依赖 CASCADE', async () => {
    const conn = getConnection();
    await conn.execute('PRAGMA foreign_keys = OFF');
    const { accountId, domainId, domainName } = await seedAccount('nofk');

    await DnsAccountOperations.deleteWithCascade(accountId);

    expect(await countRows('dns_accounts', 'id = ?', [accountId])).toBe(0);
    expect(await countRows('domains', 'id = ?', [domainId])).toBe(0);
    expect(await countRows('dns_records', 'domain_id = ?', [domainId])).toBe(0);
    expect(await countRows('domain_permissions', 'domain_id = ?', [domainId])).toBe(0);
    expect(await countRows('renewable_domains', 'account_id = ?', [accountId])).toBe(0);
    expect(await countRows('ns_monitor_domains', 'domain_name = ?', [domainName])).toBe(0);
  });

  it('中途失败时整体回滚，不留半清理状态', async () => {
    const conn = getConnection();
    const { accountId, domainId, domainName } = await seedAccount('rollback');
    await conn.execute("CREATE TRIGGER boom BEFORE DELETE ON renewable_domains BEGIN SELECT RAISE(ABORT, 'boom'); END");

    await expect(DnsAccountOperations.deleteWithCascade(accountId)).rejects.toThrow();

    expect(await countRows('dns_accounts', 'id = ?', [accountId])).toBe(1);
    expect(await countRows('domains', 'id = ?', [domainId])).toBe(1);
    expect(await countRows('dns_records', 'domain_id = ?', [domainId])).toBe(1);
    expect(await countRows('domain_permissions', 'domain_id = ?', [domainId])).toBe(1);
    expect(await countRows('renewable_domains', 'account_id = ?', [accountId])).toBe(1);
    expect(await countRows('ns_monitor_domains', 'domain_name = ?', [domainName])).toBe(1);

    await conn.execute('DROP TRIGGER IF EXISTS boom');
    await DnsAccountOperations.deleteWithCascade(accountId);
  });

  it('同名域名仍被其它账号持有时，不删该域名的 NS 监控', async () => {
    const shared = 'shared.example.com';
    const keep = await seedAccount('shared-keep', { domainName: shared });
    const drop = await seedAccount('shared-drop', { domainName: shared });

    await DnsAccountOperations.deleteWithCascade(drop.accountId);

    // 域名行只删掉被删账号的那条；监控因为还有持有者而**完全不删**
    // （与单域名删除路由一致：hasSameNameDomain 时不动该域名的任何监控）
    expect(await countRows('domains', 'account_id = ?', [keep.accountId])).toBe(1);
    expect(await countRows('domains', 'account_id = ?', [drop.accountId])).toBe(0);
    expect(await countRows('ns_monitor_domains', 'domain_name = ?', [shared])).toBe(2);
  });

  it('只清理目标账号的数据，不影响其它账号', async () => {
    const keep = await seedAccount('keep');
    const drop = await seedAccount('drop');

    await DnsAccountOperations.deleteWithCascade(drop.accountId);

    expect(await countRows('domains', 'account_id = ?', [keep.accountId])).toBe(1);
    expect(await countRows('dns_records', 'domain_id = ?', [keep.domainId])).toBe(1);
    expect(await countRows('renewable_domains', 'account_id = ?', [keep.accountId])).toBe(1);
    expect(await countRows('ns_monitor_domains', 'domain_name = ?', [keep.domainName])).toBe(1);
  });

  it('账号不存在时返回 0 且不抛错', async () => {
    expect(await DnsAccountOperations.deleteWithCascade(999999)).toEqual({ domains: 0, renewable: 0 });
  });
});