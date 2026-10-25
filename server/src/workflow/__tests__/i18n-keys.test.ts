import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ALL_ACTIONS } from '../actions/registry';
import { buildStaticMeta } from '../meta';

/**
 * 服务端下发的文案键守护（重构后版本）。
 *
 * 动作的 label / description、参数的 label / hint 都是**服务端**给客户端的 key，
 * 客户端源码里只有查表调用，字面量扫描扫不到——一旦某个 key 在客户端没有对应文案，
 * 界面就会直接把 `workflow.action.xxx` 原文显示出来。
 *
 * 重构前这里读的是 client/src/i18n/locales/*.json；新栈已去掉多语言，
 * 客户端改为集中文案表 client/src/features/workflows/workflow-labels.ts，
 * 因此守护目标随之改为「该表覆盖服务端下发的全部 key」。
 */
const LABELS_FILE = path.resolve(__dirname, '../../../../client/src/features/workflows/workflow-labels.ts');

function collectKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  const add = (key: string | undefined, where: string) => {
    if (!key) return;
    if (!/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)+$/.test(key)) return;
    if (!keys.has(key)) keys.set(key, where);
  };
  // 触发器声明同样会把 key 下发给客户端（trigger label、param label、hint），
  // 之前只守 ALL_ACTIONS，导致新增触发器参数时文案可能缺键。
  for (const item of buildStaticMeta('triggerTypes')) {
    add(item.label as string | undefined, 'trigger.' + String(item.value) + '.label');
    for (const param of (item.params as Array<{ label?: string; hint?: string }> | undefined) ?? []) {
      add(param.label, 'trigger.' + String(item.value) + '.param.label');
      add(param.hint, 'trigger.' + String(item.value) + '.param.hint');
    }
  }

  for (const action of ALL_ACTIONS) {
    add(action.label, action.name + '.label');
    add((action as { description?: string }).description, action.name + '.description');
    for (const param of action.params ?? []) {
      add(param.label, action.name + '.params.' + param.key + '.label');
      add((param as { hint?: string }).hint, action.name + '.params.' + param.key + '.hint');
    }
  }
  return keys;
}

/** 客户端文案表里出现过的 key（按 'key': '文案' 形式抓） */
function collectClientKeys(): Set<string> {
  const source = fs.readFileSync(LABELS_FILE, 'utf8');
  const keys = new Set<string>();
  for (const match of source.matchAll(/['"]([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)['"]\s*:/g)) {
    keys.add(match[1]);
  }
  return keys;
}

describe('服务端下发的文案键', () => {
  it('客户端的 workflow 文案表覆盖服务端下发的全部 key', () => {
    const keys = collectKeys();
    expect(keys.size).toBeGreaterThan(20);

    expect(fs.existsSync(LABELS_FILE), '客户端文案表不存在：' + LABELS_FILE).toBe(true);
    const clientKeys = collectClientKeys();
    expect(clientKeys.size).toBeGreaterThan(20);

    const missing = [...keys.entries()]
      .filter(([key]) => !clientKeys.has(key))
      .map(([key, where]) => key + '（' + where + '）');

    expect(missing, '客户端文案表缺少：\n' + missing.slice(0, 20).join('\n')).toEqual([]);
  });
});
