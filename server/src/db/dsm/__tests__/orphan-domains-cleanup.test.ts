import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ORPHAN_DOMAIN_CLEANUP_SQL } from '../init-dsm';

/**
 * 用真实 SQLite 内存库验证清理语句可执行（跨库写法都是 NOT EXISTS + IN 子查询）。
 */
describe('孤儿域名清理 SQL', () => {
  function seed() {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE dns_accounts (id INTEGER PRIMARY KEY)');
    db.exec('CREATE TABLE domains (id INTEGER PRIMARY KEY, name TEXT, account_id INTEGER)');
    db.exec('CREATE TABLE dns_records (id INTEGER PRIMARY KEY, domain_id INTEGER, value TEXT)');
    db.exec('CREATE TABLE domain_permissions (id INTEGER PRIMARY KEY, domain_id INTEGER, user_id INTEGER)');

    db.exec('INSERT INTO dns_accounts (id) VALUES (1)');
    db.exec("INSERT INTO domains (id, name, account_id) VALUES (10, 'keep.com', 1)");
    db.exec("INSERT INTO dns_records (id, domain_id, value) VALUES (100, 10, '1.1.1.1')");
    db.exec('INSERT INTO domain_permissions (id, domain_id, user_id) VALUES (1000, 10, 1)');
    db.exec("INSERT INTO domains (id, name, account_id) VALUES (11, 'orphan.com', 99)");
    db.exec("INSERT INTO dns_records (id, domain_id, value) VALUES (101, 11, '2.2.2.2')");
    db.exec('INSERT INTO domain_permissions (id, domain_id, user_id) VALUES (1001, 11, 1)');
    return db;
  }

  it('清掉孤儿域名及其记录/权限，保留正常域名', () => {
    const db = seed();
    for (const sql of ORPHAN_DOMAIN_CLEANUP_SQL) db.exec(sql);

    const domains = db.prepare('SELECT id FROM domains ORDER BY id').all() as Array<{ id: number }>;
    const records = db.prepare('SELECT id FROM dns_records ORDER BY id').all() as Array<{ id: number }>;
    const perms = db.prepare('SELECT id FROM domain_permissions ORDER BY id').all() as Array<{ id: number }>;

    expect(domains.map((row) => row.id)).toEqual([10]);
    expect(records.map((row) => row.id)).toEqual([100]);
    expect(perms.map((row) => row.id)).toEqual([1000]);
    db.close();
  });

  it('没有孤儿数据时幂等', () => {
    const db = seed();
    for (const sql of ORPHAN_DOMAIN_CLEANUP_SQL) db.exec(sql);
    expect(() => { for (const sql of ORPHAN_DOMAIN_CLEANUP_SQL) db.exec(sql); }).not.toThrow();
    expect((db.prepare('SELECT COUNT(*) AS cnt FROM domains').get() as { cnt: number }).cnt).toBe(1);
    db.close();
  });
});