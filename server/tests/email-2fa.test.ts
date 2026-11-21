import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';
import { getConnection } from '../src/db/connection';
import { TwoFAOperations, UserOperations } from '../src/db/bal/business-adapter';

/**
 * #43 邮箱 2FA 的两条 P0 回归：
 *   1. setEmailEnabled 首次开启时 INSERT 必须满足 user_2fa 的 NOT NULL 列；
 *   2. 用户查询必须带上 email_verified，否则登录侧恒判 false。
 */
let handle: TestDbHandle;

async function createUser(username: string): Promise<number> {
  await getConnection().run(
    'INSERT INTO users (username, email, email_verified, password_hash, role_level, status) VALUES (?, ?, ?, ?, ?, ?)',
    [username, `${username}@example.com`, 1, 'hash', 1, 1],
  );
  const row = await getConnection().get<{ id: number }>('SELECT last_insert_rowid() AS id');
  return Number(row?.id ?? 0);
}

describe('邮箱 2FA 开关', () => {
  beforeAll(async () => { handle = await setupTestDb(); });
  afterAll(async () => { await handle.cleanup(); });

  it('首次开启不会触发 user_2fa 的 NOT NULL 约束', async () => {
    const userId = await createUser('email2fa');
    await expect(TwoFAOperations.setEmailEnabled(userId, true)).resolves.toBeUndefined();
    await expect(TwoFAOperations.isEmailEnabled(userId)).resolves.toBe(true);

    await TwoFAOperations.setEmailEnabled(userId, false);
    await expect(TwoFAOperations.isEmailEnabled(userId)).resolves.toBe(false);
  });

  it('只改昵称（不带 email_verified）不会把未验证邮箱标记为已验证', async () => {
    await getConnection().run(
      'INSERT INTO users (username, email, email_verified, password_hash, role_level, status) VALUES (?, ?, ?, ?, ?, ?)',
      ['nicknameonly', 'nv@example.com', 0, 'hash', 1, 1],
    );
    const row = await getConnection().get<{ id: number }>('SELECT last_insert_rowid() AS id');
    const userId = Number(row?.id ?? 0);

    // 模拟「客户端恒定提交 email、但邮箱没变」时只更新 nickname 的路径
    await UserOperations.update(userId, { nickname: '改名' });
    const after = await UserOperations.getById(userId) as { nickname?: string; email_verified?: number } | undefined;
    expect(after?.nickname).toBe('改名');
    expect(Number(after?.email_verified)).toBe(0);
  });

  it('用户查询返回 email_verified（登录侧判断依赖它）', async () => {
    const userId = await createUser('emailverified');
    const byId = await UserOperations.getById(userId) as { email_verified?: number } | undefined;
    const byName = await UserOperations.getByUsername('emailverified') as { email_verified?: number } | undefined;
    const byEmail = await UserOperations.getByEmail('emailverified@example.com') as { email_verified?: number } | undefined;
    expect(Number(byId?.email_verified)).toBe(1);
    expect(Number(byName?.email_verified)).toBe(1);
    expect(Number(byEmail?.email_verified)).toBe(1);
  });
});