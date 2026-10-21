import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * i18n 覆盖守护：代码里用到的静态 key 必须在**每个语言**里都存在。
 *
 * 缺 key 时界面会直接把 `teams.noTeams` 这种原文显示出来——这正是「i18n 异常」
 * 最常见的成因，而且只在特定语言的特定分支（如空列表）才出现，很难被手工发现。
 */
const SRC = path.resolve(process.cwd(), 'src');
const LOCALES = path.join(SRC, 'i18n/locales');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(full, out);
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** 收集 `t('a.b.c')` 形式的静态 key；模板字符串与变量无法静态判定，跳过 */
function collectUsedKeys(): Map<string, string> {
  const used = new Map<string, string>();
  for (const file of walk(SRC)) {
    if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\bt\(\s*'([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)'/g)) {
      if (!used.has(match[1])) used.set(match[1], path.relative(SRC, file));
    }
  }
  return used;
}

function resolveKey(messages: Record<string, unknown>, key: string): unknown {
  let current: unknown = messages;
  for (const segment of key.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

describe('i18n 覆盖', () => {
  it('每个语言都包含代码里用到的全部静态 key', () => {
    const used = collectUsedKeys();
    expect(used.size).toBeGreaterThan(100);

    const localeFiles = fs.readdirSync(LOCALES).filter((f) => f.endsWith('.json'));
    expect(localeFiles.length).toBeGreaterThanOrEqual(10);

    const problems: string[] = [];
    for (const file of localeFiles) {
      const data = JSON.parse(fs.readFileSync(path.join(LOCALES, file), 'utf8')) as { messages?: Record<string, unknown> };
      const messages = data.messages ?? {};
      for (const [key, source] of used) {
        if (resolveKey(messages, key) === undefined) problems.push(`${file} 缺少 ${key}（使用于 ${source}）`);
      }
    }

    expect(problems, `缺失的翻译：\n${problems.slice(0, 20).join('\n')}`).toEqual([]);
  });
});
