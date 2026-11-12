import { describe, expect, it } from 'vitest';
import { ORPHAN_DOMAIN_CLEANUP_SQL, ORPHAN_RENEWABLE_CLEANUP_SQL } from '../init-dsm';
import { DatabaseSync } from 'node:sqlite';

/**
 * 用真实 SQLite 内存库验证清理语句可执行（跨库写法都是 NOT EXISTS + IN 子查询）。
 *
 * 注意：这是 SQL 语法/语义冒烟，不校验「表名是否与真实 schema 一致」——
 * 那一层由 server/tests/account-cascade-delete.test.ts 用真实 DSM 建库覆盖。
 */
describe('孤儿数据清理 SQL', () => {
  function seed() {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE dns_accounts (id INTEGER PRIMARY KEY)');
    db.exec('CREATE TABLE domains (id INTEGER PRIMARY KEY, name TEXT, account_id INTEGER)');
    db.exec('CREATE TABLE dns_records (id INTEGER PRIMARY KEY, domain_id INTEGER, value TEXT)');
    db.exec('CREATE TABLE domain_permissions (id INTEGER PRIMARY KEY, domain_id INTEGER, user_id INTEGER)');
    db.exec('CREATE TABLE failover_configs (id INTEGER PRIMARY KEY, domain_id INTEGER)');
    db.exec('CREATE TABLE failover_status (id INTEGER PRIMARY KEY, config_id INTEGER)');
    db.exec('CREATE TABLE servicemonitor_monitors (id INTEGER PRIMARY KEY, domain_id INTEGER)');
    db.exec('CREATE TABLE renewable_domains (id INTEGER PRIMARY KEY, account_id INTEGER, full_domain TEXT)');

    db.exec('INSERT INTO dns_accounts (id) VALUES (1)');
    // 正常域名（账号 1 存在）
    db.exec("INSERT INTO domains (id, name, account_id) VALUES (10, 'keep.com', 1)");
    db.exec("INSERT INTO dns_records (id, domain_id, value) VALUES (100, 10, '1.1.1.1')");
    db.exec('INSERT INTO domain_permissions (id, domain_id, user_id) VALUES (1000, 10, 1)');
    db.exec('INSERT INTO failover_configs (id, domain_id) VALUES (10000, 10)');
    db.exec('INSERT INTO failover_status (id, config_id) VALUES (100000, 10000)');
    db.exec('INSERT INTO servicemonitor_monitors (id, domain_id) VALUES (1000000, 10)');
    db.exec("INSERT INTO renewable_domains (id, account_id, full_domain) VALUES (10000000, 1, 'keep.com')");
    // 孤儿域名（账号 99 不存在）
    db.exec("INSERT INTO domains (id, name, account_id) VALUES (11, 'orphan.com', 99)");
    db.exec("INSERT INTO dns_records (id, domain_id, value) VALUES (101, 11, '2.2.2.2')");
    db.exec('INSERT INTO domain_permissions (id, domain_id, user_id) VALUES (1001, 11, 1)');
    db.exec('INSERT INTO failover_configs (id, domain_id) VALUES (10001, 11)');
    db.exec('INSERT INTO failover_status (id, config_id) VALUES (100001, 10001)');
    db.exec('INSERT INTO servicemonitor_monitors (id, domain_id) VALUES (1000001, 11)');
    // 孤儿续期行（账号 99 不存在）
    db.exec("INSERT INTO renewable_domains (id, account_id, full_domain) VALUES (10000001, 99, 'orphan.com')");
    return db;
  }

  function ids(db: DatabaseSync, sql: string): number[] {
    return (db.prepare(sql).all() as Array<{ id: number }>).map((row) => row.id);
  }

  it('清掉孤儿域名及其全部关联行，保留正常账号的数据', () => {
    const db = seed();
    for (const sql of ORPHAN_DOMAIN_CLEANUP_SQL) db.exec(sql);
    for (const sql of ORPHAN_RENEWABLE_CLEANUP_SQL) db.exec(sql);

    expect(ids(db, 'SELECT id FROM domains ORDER BY id')).toEqual([10]);
    expect(ids(db, 'SELECT id FROM dns_records ORDER BY id')).toEqual([100]);
    expect(ids(db, 'SELECT id FROM domain_permissions ORDER BY id')).toEqual([1000]);
    expect(ids(db, 'SELECT id FROM failover_configs ORDER BY id')).toEqual([10000]);
    expect(ids(db, 'SELECT id FROM failover_status ORDER BY id')).toEqual([100000]);
    expect(ids(db, 'SELECT id FROM servicemonitor_monitors ORDER BY id')).toEqual([1000000]);
    expect(ids(db, 'SELECT id FROM renewable_domains ORDER BY id')).toEqual([10000000]);
    db.close();
  });

  it('没有孤儿数据时幂等', () => {
    const db = seed();
    for (const sql of ORPHAN_DOMAIN_CLEANUP_SQL) db.exec(sql);
    for (const sql of ORPHAN_RENEWABLE_CLEANUP_SQL) db.exec(sql);
    expect(() => {
      for (const sql of ORPHAN_DOMAIN_CLEANUP_SQL) db.exec(sql);
      for (const sql of ORPHAN_RENEWABLE_CLEANUP_SQL) db.exec(sql);
    }).not.toThrow();
    expect(ids(db, 'SELECT id FROM domains')).toEqual([10]);
    expect(ids(db, 'SELECT id FROM renewable_domains')).toEqual([10000000]);
    db.close();
  });
});