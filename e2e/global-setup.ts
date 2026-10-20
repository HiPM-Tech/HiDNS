import { chromium, request, type FullConfig } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 全局登录一次，把 Cookie 存成 storageState 供所有 UI 用例复用。
 *
 * 为什么：登录接口有失败次数限流（login_attempts），如果每条用例各自登录，
 * 跑几条就会 429，后续用例只能 skip——这正是历史上一批 UI 用例长期无效的原因之一。
 */
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const USERNAME = process.env.E2E_USERNAME || 'admin';
const PASSWORD = process.env.E2E_PASSWORD || 'admin';

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const stateDir = path.join(__dirname, '.auth');
  fs.mkdirSync(stateDir, { recursive: true });
  const statePath = path.join(stateDir, 'state.json');

  const api = await request.newContext({ baseURL: BASE_URL });
  try {
    const res = await api.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } });
    if (res.status() === 200) {
      await api.storageState({ path: statePath });
      fs.writeFileSync(path.join(stateDir, 'ok'), '1');
      return;
    }
  } catch {
    // 忽略：下面写空状态，需要的用例会自行 skip
  } finally {
    await api.dispose();
  }

  fs.writeFileSync(statePath, JSON.stringify({ cookies: [], origins: [] }));
  fs.rmSync(path.join(stateDir, 'ok'), { force: true });
}

export { chromium };
