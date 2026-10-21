import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ALL_ACTIONS } from '../actions/registry';

/**
 * 服务端下发的 i18n key 守护。
 *
 * 动作的 label / description、参数的 label / hint 都是**服务端**给客户端的 key，
 * 客户端源码里只有 t(item.label)，字面量扫描扫不到——一旦某个语言缺 key，
 * 界面就会直接把 `workflow.action.xxx` 原文显示出来。
 */
const LOCALES_DIR = path.resolve(__dirname, '../../../../client/src/i18n/locales');

function collectKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  const add = (key: string | undefined, where: string) => {
    if (!key) return;
    // 只关心形如 a.b.c 的 key；纯文本（如 'A'）不是 key
    if (!/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)+$/.test(key)) return;
    if (!keys.has(key)) keys.set(key, where);
  };
  for (const action of ALL_ACTIONS) {
    add(action.label, `${action.name}.label`);
    add((action as { description?: string }).description, `${action.name}.description`);
    for (const param of action.params ?? []) {
      add(param.label, `${action.name}.params.${param.key}.label`);
      add((param as { hint?: string }).hint, `${action.name}.params.${param.key}.hint`);
    }
  }
  return keys;
}

function resolveKey(messages: Record<string, unknown>, key: string): unknown {
  let current: unknown = messages;
  for (const segment of key.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

describe('服务端下发的 i18n key', () => {
  it('每个语言都包含动作与参数用到的全部 key', () => {
    const keys = collectKeys();
    expect(keys.size).toBeGreaterThan(20);

    const localeFiles = fs.readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json'));
    expect(localeFiles.length).toBeGreaterThanOrEqual(10);

    const problems: string[] = [];
    for (const file of localeFiles) {
      const data = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), 'utf8')) as { messages?: Record<string, unknown> };
      const messages = data.messages ?? {};
      for (const [key, where] of keys) {
        if (resolveKey(messages, key) === undefined) problems.push(`${file} 缺少 ${key}（${where}）`);
      }
    }

    expect(problems, `缺失的翻译：\n${problems.slice(0, 20).join('\n')}`).toEqual([]);
  });
});
