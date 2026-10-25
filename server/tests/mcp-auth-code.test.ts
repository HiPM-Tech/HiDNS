import { describe, expect, it, afterAll } from 'vitest';
import { getConnection } from '../src/db/connection';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';
import { McpOperations } from '../src/db/bal/business-adapter';

/**
 * MCP 授权码消费（第四/五轮连续踩到的 P0）。
 * - 首次兑换必须成功（原子领取后不能再拿 row.used 复查）；
 * - 重放必须失败；
 * - 过期码必须失败。
 */
let handle: TestDbHandle;

describe('MCP 授权码消费', () => {
  it('首次成功、重放失败、过期失败', async () => {
    handle = await setupTestDb();
    const conn = getConnection();
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();

    await McpOperations.createAuthCode({
      code: 'code-ok', client_id: 'c1', user_id: 1, redirect_uri: 'http://127.0.0.1/cb', scope: 'mcp:read', expires_at: future,
    });
    const first = await McpOperations.consumeAuthCode('code-ok');
    expect(first).not.toBeNull();
    expect(first?.client_id).toBe('c1');
    expect(await McpOperations.consumeAuthCode('code-ok')).toBeNull();

    await McpOperations.createAuthCode({
      code: 'code-expired', client_id: 'c1', user_id: 1, redirect_uri: 'http://127.0.0.1/cb', scope: null, expires_at: past,
    });
    expect(await McpOperations.consumeAuthCode('code-expired')).toBeNull();

    expect(conn).toBeTruthy();
  });

  afterAll(async () => {
    await handle?.cleanup();
  });
});
