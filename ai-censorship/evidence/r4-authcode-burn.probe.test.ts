import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, type TestDbHandle } from '../tests/helpers/test-db';
let h: TestDbHandle; let McpOperations: any; let conn: any;
beforeAll(async () => {
  h = await setupTestDb();
  conn = (await import('../src/db/connection')).getConnection();
  McpOperations = (await import('../src/db/bal/business-adapter') as any).McpOperations;
});
afterAll(async () => { await h?.cleanup(); });
describe('A4 复现补充', () => {
  it('兑换返回 null 但数据库里 used 已被置 true（码被烧掉）', async () => {
    const code = 'probe-burn-' + Date.now();
    await McpOperations.createAuthCode({ code, client_id: 'c', user_id: 7, redirect_uri: 'r', scope: null, expires_at: '2030-01-01 00:00:00' });
    const before = await conn.query('SELECT used FROM mcp_oauth_auth_codes WHERE code = ?', [code]);
    const r1 = await McpOperations.consumeAuthCode(code);
    const after1 = await conn.query('SELECT used FROM mcp_oauth_auth_codes WHERE code = ?', [code]);
    const r2 = await McpOperations.consumeAuthCode(code);
    console.log('[A4+] used before =', JSON.stringify(before), '| consume#1 =', r1, '| used after =', JSON.stringify(after1), '| consume#2 =', r2);
    expect(r1).toBeNull();
    expect(JSON.stringify(after1)).toMatch(/true|1/);
  });
});
