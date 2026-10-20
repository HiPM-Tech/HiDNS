import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * 架构守卫：提供商实现不得直接依赖业务适配层（BAL）与服务层。
 *
 * 为什么：`providers/**` 只该懂"怎么调厂商 API"。凭据存在哪张表、走哪个 service
 * 取适配器，都是上层的事。提供商直接 import BAL 会让依赖方向倒挂，并且把
 * "谁有资格读凭据"的判断散落到每个提供商里 —— 那正是跨提供商凭据复用被单方面
 * 决定的温床。
 *
 * 正确做法：凭证解析走 DNS 模块子功能 `lib/dns/account-context.ts`，
 * 跨提供商复用规则走 `providers/credential-sharing.ts`（双向声明）。
 *
 * 说明：提供商里仍有对 `service/renewalScheduler` 与 `service/whois` 的 import，
 * 那是"提供商提供调度器子类"的既有模式，与凭据路径无关，本守卫不覆盖。
 */

const PROVIDERS_DIR = join(process.cwd(), 'src', 'lib', 'dns', 'providers');

const FORBIDDEN: Array<{ needle: string; reason: string }> = [
  {
    needle: 'db/bal/',
    reason: '禁止直接依赖 BAL（业务适配层），应走 lib/dns/account-context',
  },
  {
    needle: 'service/dns-provider-service',
    reason: '禁止直接依赖 dns-provider-service，应走 lib/dns/account-context',
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('提供商层的依赖方向', () => {
  const files = walk(PROVIDERS_DIR);

  it('扫描到的提供商文件数量合理（防止守卫空转）', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('没有任何提供商文件直接 import BAL 或 dns-provider-service', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const rule of FORBIDDEN) {
        if (source.includes(rule.needle)) {
          offenders.push(relative(PROVIDERS_DIR, file) + ': ' + rule.reason);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
