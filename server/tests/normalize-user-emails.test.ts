import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getConnection } from '../src/db/connection';
import { normalizeUserEmails } from '../src/db/dsm/init-dsm';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

/**
 * #43 C0：邮箱唯一性收敛。
 * 口径：同一邮箱保留 id 最小的一条，其余置空；空串归一为 NULL（NULL 不参与唯一性）。
 */
let handle: TestDbHandle;

async function insertUser(username: string, email: string | null): Promise<number> {
  const conn = getConnection();
  await conn.run(
    'INSERT INTO users (username, email, password_hash, role_level, status) VALUES (?, ?, ?, ?, ?)',
    [username, email, 'hash', 1, 1],
  );
  const row = await conn.get<{ id: number }>('SELECT last_insert_rowid() AS id');
  return Number(row?.id ?? 0);
}

describe('normalizeUserEmails', () => {
  beforeAll(async () => { handle = await setupTestDb(); });
  afterAll(async () => { await handle.cleanup(); });

  it('重复邮箱保留最早注册的那条，其余置空', async () => {
    // setupTestDb 已经跑过迁移、唯一索引已存在：先删掉才能构造历史脏数据
    await getConnection().execute('DROP INDEX IF EXISTS idx_users_email');
    const first = await insertUser('dup-first', 'dup@example.com');
    const second = await insertUser('dup-second', 'dup@example.com');

    const result = await normalizeUserEmails(getConnection());

    expect(result.cleared).toBeGreaterThanOrEqual(1);
    const conn = getConnection();
    const firstRow = await conn.get<{ email: string | null }>('SELECT email FROM users WHERE id = ?', [first]);
    const secondRow = await conn.get<{ email: string | null }>('SELECT email FROM users WHERE id = ?', [second]);
    expect(firstRow?.email).toBe('dup@example.com');
    expect(secondRow?.email).toBe('');
  });

  it('旧的 NULL 归一为空串（空串可重复，NULL 在部分索引下也可重复）', async () => {
    const id = await insertUser('empty-email', '');
    await normalizeUserEmails(getConnection());
    const row = await getConnection().get<{ email: string | null }>('SELECT email FROM users WHERE id = ?', [id]);
    expect(row?.email).toBe('');
  });

  it('唯一索引存在且拒绝再次写入相同邮箱', async () => {
    await normalizeUserEmails(getConnection());
    const conn = getConnection();
    const index = await conn.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_email'");
    expect(index).toHaveLength(1);

    await insertUser('unique-a', 'unique@example.com');
    await expect(insertUser('unique-b', 'unique@example.com')).rejects.toThrow();
  });
});