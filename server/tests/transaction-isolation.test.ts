import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getConnection, transaction } from '../src/db/connection';
import { DnsAccountOperations } from '../src/db/bal/business-adapter';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

/**
 * SQLite 事务隔离回归。
 *
 * 背景：SQLite 只有一个连接句柄，`BEGIN` 之后所有走句柄的语句都落在同一个事务里。
 * 修复方式：事务期间打标记，事务外的语句排队等待（dal/tx-gate.ts）。
 */
let handle: TestDbHandle;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function createAccount(name: string): Promise<number> {
  const conn = getConnection();
  await conn.run(
    'INSERT INTO users (username, email, password_hash, role_level, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [`u-${name}`, `${name}@example.com`, 'hash', 1, 1, new Date().toISOString()],
  );
  const user = await conn.get<{ id: number }>('SELECT last_insert_rowid() AS id');
  await conn.run(
    'INSERT INTO dns_accounts (type, name, config, remark, created_by, team_id, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ['spaceship', name, '{}', '', Number(user?.id ?? 0), null, 1, new Date().toISOString()],
  );
  const account = await conn.get<{ id: number }>('SELECT last_insert_rowid() AS id');
  return Number(account?.id ?? 0);
}

describe('SQLite 事务隔离', () => {
  beforeAll(async () => { handle = await setupTestDb(); });
  afterAll(async () => { await handle.cleanup(); });

  it('并发删除两个账号不再撞 cannot start a transaction within a transaction', async () => {
    const a = await createAccount('tx-a');
    const b = await createAccount('tx-b');

    const results = await Promise.allSettled([
      DnsAccountOperations.deleteWithCascade(a),
      DnsAccountOperations.deleteWithCascade(b),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
  });

  it('事务回滚不会带走并发请求已提交的写入', async () => {
    const conn = getConnection();

    const failing = transaction(async () => {
      await conn.execute(
        "INSERT INTO users (username, email, password_hash, role_level, status, created_at) VALUES ('tx-inside', 'in@example.com', 'hash', 1, 1, '2026-01-01T00:00:00Z')",
      );
      await sleep(60);
      throw new Error('boom');
    });

    const concurrent = (async () => {
      await sleep(10);   // 让事务先进入
      await conn.execute(
        "INSERT INTO users (username, email, password_hash, role_level, status, created_at) VALUES ('tx-outside', 'out@example.com', 'hash', 1, 1, '2026-01-01T00:00:00Z')",
      );
      return 'done';
    })();

    await expect(failing).rejects.toThrow('boom');
    await expect(concurrent).resolves.toBe('done');

    const inside = await conn.query('SELECT username FROM users WHERE username = ?', ['tx-inside']);
    const outside = await conn.query('SELECT username FROM users WHERE username = ?', ['tx-outside']);
    expect(inside).toHaveLength(0);   // 事务内的插入被回滚
    expect(outside).toHaveLength(1);  // 并发提交的写入保留
  });
});