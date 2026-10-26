import { describe, expect, it, afterAll } from 'vitest';
import { getConnection } from '../src/db/connection';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';
import { TokenOperations } from '../src/db/bal/business-adapter';
import { initializeDSM } from '../src/db/dsm/init-dsm';
import { hashToken, verifyToken } from '../src/service/token';

/**
 * 数据库引导冒烟测试。
 *
 * 替代已腐化的 tests/db-migration.test.ts（它 import 了不存在的 `src/db/init-dsm`，
 * 且断言的是旧 schema）。这里只守住「新库能被 DSM 建起来」这条底线：
 * 关键表存在、users 用 password_hash（不是旧的 password）、能写入并读回。
 */
let handle: TestDbHandle;

describe('数据库引导', () => {
  it('DSM 能建出关键表，且 users 使用 password_hash 列', async () => {
    handle = await setupTestDb();
    const conn = getConnection();

    const tables = await conn.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'",
    );
    const names = tables.map((row) => row.name);
    for (const table of ['users', 'dns_accounts', 'domains', 'dns_records', 'system_settings']) {
      expect(names, '缺少表 ' + table).toContain(table);
    }

    const columns = await conn.query<{ name: string }>("PRAGMA table_info('users')");
    const columnNames = columns.map((row) => row.name);
    expect(columnNames).toContain('password_hash');
    expect(columnNames).not.toContain('password');

    await conn.run(
      'INSERT INTO users (username, email, password_hash, role_level, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['bootstrap-user', 'bootstrap@example.com', 'hash', 1, 1, new Date().toISOString()],
    );
    const rows = await conn.query<{ username: string }>('SELECT username FROM users WHERE username = ?', ['bootstrap-user']);
    expect(rows).toHaveLength(1);
  });

  it('已有 DSM 数据库在升级时迁移旧 Token，dry-run 不写入且重复初始化不扩大权限', async () => {
    const user = await getConnection().get<{ id: number }>('SELECT id FROM users WHERE username = ?', ['bootstrap-user']);
    expect(user).toBeDefined();
    const tokens = [
      { plain: 'hidns_migration_dns', old: ['dns'], expected: { dns: ['*'] } },
      { plain: 'hidns_migration_mcp', old: ['mcp'], expected: { mcp: ['*'] } },
      { plain: 'hidns_migration_all', old: ['*'], expected: { dns: ['*'], mcp: ['*'] } },
      { plain: 'hidns_migration_empty', old: [], expected: {} },
    ];
    for (const token of tokens) {
      await TokenOperations.create({ user_id: user!.id, name: token.plain, token_hash: hashToken(token.plain),
        allowed_domains: '[]', allowed_services: JSON.stringify(token.old), max_role: 1 });
    }
    await initializeDSM(true);
    expect((await TokenOperations.getByTokenHash(hashToken(tokens[0].plain)))?.allowed_services).toBe('["dns"]');
    await initializeDSM();
    for (const token of tokens) {
      const stored = await TokenOperations.getByTokenHash(hashToken(token.plain));
      expect(JSON.parse(stored!.allowed_services as string)).toEqual(token.expected);
      expect((await verifyToken(token.plain))?.allowedServices).toEqual(token.expected);
    }
    const first = await TokenOperations.getByTokenHash(hashToken(tokens[0].plain));
    await TokenOperations.updateByUser(Number(first!.id), user!.id, { allowed_services: '{"dns":["records.read"]}' });
    await initializeDSM();
    expect((await verifyToken(tokens[0].plain))?.allowedServices).toEqual({ dns: ['records.read'] });
  });

  afterAll(async () => {
    await handle?.cleanup();
  });
});
