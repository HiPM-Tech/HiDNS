import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { STATIC_META_SOURCES } from '../meta';

/**
 * 候选源名的构建期门禁。
 *
 * `source` 是自由字符串，写错只会在运行期变成 404、编辑器下拉静默变空。
 * 这里做**纯静态扫描**：不 import 任何模块、不看环境变量。
 * 原因：virtual 的候选源是条件注册（`HIDNS_ENABLE_VIRTUAL_PROVIDER=1` 且非生产），
 * 若从 `listProviderMetaSources()` 取全集，CI 默认不设该变量 → 断言必然失败；
 * 把它加进白名单又恰好放过它本该拦住的漂移。
 */
const SRC = path.resolve(__dirname, '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** 参数声明里用到的 source：锚成 `required: <bool> ... source: '...'`，排除 actor.source 等无关对象 */
function usedSources(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/required:\s*(?:true|false)[^}]*?\bsource:\s*'([^']+)'/g)) {
      if (!found.has(match[1])) found.set(match[1], path.relative(SRC, file));
    }
  }
  return found;
}

/** 已注册的候选源：扫描 `registerProviderMetaSource({ source: '...' })` 与路由的内建分支 */
function declaredSources(): Set<string> {
  const declared = new Set<string>(STATIC_META_SOURCES);
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/registerProviderMetaSource\(\{[\s\S]{0,200}?source:\s*'([^']+)'/g)) {
      declared.add(match[1]);
    }
    for (const match of text.matchAll(/source === '([^']+)'/g)) {
      declared.add(match[1]);
    }
  }
  return declared;
}

describe('候选源名门禁', () => {
  it('参数声明用到的每个 source 都必须真的存在', () => {
    const used = usedSources();
    const declared = declaredSources();
    // 扫描本身要有产出，否则这条用例会在「正则失效」时假绿
    expect(used.size).toBeGreaterThan(3);
    const missing = [...used.entries()].filter(([source]) => !declared.has(source));
    expect(
      missing.map(([source, file]) => `${source}（声明于 ${file}）`),
      `以下 source 没有对应的候选源实现：${missing.map(([s]) => s).join(', ')}`,
    ).toEqual([]);
  });
});
