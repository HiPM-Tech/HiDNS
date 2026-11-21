#!/usr/bin/env node
/**
 * 版本一致性：三处 package.json 与 docs/CHANGELOG.md 顶部版本必须一致（root.ai.md §版本号规范）。
 */
import { readFileSync } from 'node:fs';

const ROOT = process.cwd();
const read = (p) => JSON.parse(readFileSync(`${ROOT}/${p}`, 'utf8'));

const versions = [
  ['package.json', read('package.json').version],
  ['server/package.json', read('server/package.json').version],
  ['client/package.json', read('client/package.json').version],
];

const unique = new Set(versions.map(([, v]) => v));
if (unique.size !== 1) {
  console.error('✖ 三处 package.json 版本不一致：');
  for (const [file, v] of versions) console.error(`  ${file}: ${v}`);
  process.exit(1);
}

const version = versions[0][1];
const changelog = readFileSync(`${ROOT}/docs/CHANGELOG.md`, 'utf8');
const top = changelog.match(/^## \[([^\]]+)\]/m);
if (!top) {
  console.error('✖ docs/CHANGELOG.md 顶部没有版本条目');
  process.exit(1);
}
if (top[1] !== version) {
  console.error(`✖ CHANGELOG 顶部版本 ${top[1]} 与 package.json ${version} 不一致`);
  process.exit(1);
}

console.log(`✔ 版本一致性通过：${version}`);