import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 守卫：写接口必须走带信封校验的方法（postOk/putOk/patchOk/deleteOk 或显式 ensureOk）。
 *
 * 背景（第三轮评审 P1）：后端有多处「HTTP 200 + code:-1」，而前端只有 8/23 个 api 模块
 * 校验了 code，导致隧道删除、改资料等操作「失败却提示成功」。这条用例把约定固化下来，
 * 新增 api 忘记校验会直接失败。
 */
const SRC = path.resolve(__dirname, '../../features');

/** 允许直接使用原始写方法的位置：需要自判 code 或返回裸协议体 */
const ALLOWLIST: Array<{ file: string; pattern: RegExp; reason: string }> = [
  { file: 'auth/api.ts', pattern: /\/auth\/login/, reason: '登录需要区分 code -2（两步验证）' },
  { file: 'auth/api.ts', pattern: /\/auth\/password-reset/, reason: '找回密码需要区分业务码' },
  { file: 'auth/api.ts', pattern: /\/auth\/oauth\/start/, reason: '返回 authUrl，由服务端决定可用性' },
  { file: 'settings/api.ts', pattern: /start-bind/, reason: '绑定流程返回 authUrl' },
  { file: 'setup/setup-api.ts', pattern: /\/init\//, reason: '安装向导需要读取 success/message' },
  { file: 'workflows/workflows-api.ts', pattern: /\/workflows\/\$\{id\}\/(test|run)/, reason: '返回执行结果体' },
];

function apiFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue;
        walk(full);
      } else if (/\.ts$/.test(entry.name) && !entry.name.includes('.test.')) {
        out.push(full);
      }
    }
  };
  walk(SRC);
  return out;
}

describe('写接口信封校验约定', () => {
  it('所有写调用都经过 *Ok 方法或显式 ensureOk（allowlist 除外）', () => {
    const offenders: string[] = [];
    for (const file of apiFiles()) {
      const rel = path.relative(SRC, file).replace(/\\/g, '/');
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        const match = /http\.(post|put|patch|delete)</.exec(line);
        if (!match) return;
        if (/ensureOk|Ok</.test(line)) return;
        if (line.includes('unwrap(')) return;
        const allowed = ALLOWLIST.some((entry) => entry.file === rel && entry.pattern.test(line));
        if (allowed) return;
        offenders.push(rel + ':' + (index + 1) + ' → ' + line.trim());
      });
    }
    expect(offenders).toEqual([]);
  });

  it('http 提供了带校验的写方法', async () => {
    const { http } = await import('../http');
    for (const method of ['postOk', 'putOk', 'patchOk', 'deleteOk'] as const) {
      expect(typeof http[method]).toBe('function');
    }
  });
});
