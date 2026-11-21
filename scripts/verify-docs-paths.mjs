#!/usr/bin/env node
/**
 * 校验文档里引用的源码路径是否存在（root.ai.md §提交前校验 第 8 条）。
 *
 * 归档类文档（CHANGELOG / review 快照 / 规划与进度）按规范允许引用旧路径，直接跳过。
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const DOCS = join(ROOT, 'docs');
// 归档/历史类文档按 root.ai.md 的口径允许引用旧路径
const SKIP_FILES = [
  /CHANGELOG\.md$/,
  /\/review\//,
  /\/archive\//,
  /[_-]PLAN\.md$/,
  /progress\.md$/,
  /FIXES\.md$/,
  /KNOWN_ISSUES\.md$/,
  /dsm-(complete-takeover|optimization-plan)\.md$/,
  /-audit\.md$/,
  /WORKFLOW_ENGINE_(DESIGN|NAMESPACE_PLAN)\.md$/,
];
// 注意顺序：先 tsx 再 ts，否则 .tsx 会被截成 .ts
const PATH_RE = /\b(?:server|client)\/src\/[A-Za-z0-9_./-]*\.(?:tsx|ts)/g;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

const misses = [];
for (const file of walk(DOCS)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (SKIP_FILES.some((re) => re.test(rel))) continue;
  const text = readFileSync(file, 'utf8');
  for (const match of new Set(text.match(PATH_RE) ?? [])) {
    if (!existsSync(join(ROOT, match))) misses.push([rel, match]);
  }
}

if (misses.length > 0) {
  console.error('✖ 文档引用了不存在的源码路径：');
  for (const [file, path] of misses) console.error(`  ${file} -> ${path}`);
  process.exit(1);
}
console.log('✔ 文档路径校验通过');