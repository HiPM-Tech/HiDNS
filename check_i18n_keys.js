#!/usr/bin/env node
/**
 * 检查"界面上会不会出现原始 i18n key"。
 *
 * 两类来源：
 *   1. 前端代码里 t('xxx') 的字面量键
 *   2. 服务端下发给前端的 label（动作、参数、触发器、字段…）
 *
 * 任何一处缺失，t() 会原样回退成 key，用户就会看到 workflow.action.dns_record_list
 * 这种字符串。这个脚本把它变成构建期错误。
 *
 * 用法：node check_i18n_keys.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const EN_PATH = path.join(ROOT, 'client/src/i18n/locales/en.json');
const en = JSON.parse(fs.readFileSync(EN_PATH, 'utf8')).messages;

function resolve(key) {
  let cur = en;
  for (const seg of key.split('.')) {
    if (!cur || typeof cur !== 'object' || !(seg in cur)) return undefined;
    cur = cur[seg];
  }
  return typeof cur === 'string' ? cur : undefined;
}

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const missing = new Map();

// 1) 前端字面量键
const literalPattern = /\bt\(\s*['"`]([A-Za-z0-9_.\-]+)['"`]/g;
for (const file of walk(path.join(ROOT, 'client/src'))) {
  const src = fs.readFileSync(file, 'utf8');
  for (const match of src.matchAll(literalPattern)) {
    const key = match[1];
    if (!key.includes('.')) continue;
    if (resolve(key) === undefined) {
      if (!missing.has(key)) missing.set(key, path.relative(ROOT, file));
    }
  }
}

// 2) 服务端下发的 label（只取带点的，裸记录类型名如 A / MX 是文本不是键）
const labelPattern = /label:\s*'([A-Za-z0-9_]+\.[A-Za-z0-9_.\-]+)'/g;
for (const file of walk(path.join(ROOT, 'server/src'))) {
  const src = fs.readFileSync(file, 'utf8');
  for (const match of src.matchAll(labelPattern)) {
    const key = match[1];
    if (resolve(key) === undefined) {
      if (!missing.has(key)) missing.set(key, path.relative(ROOT, file));
    }
  }
}

// 3) 动态拼接的键家族：t(`provider.${type}`) 这类上面的扫描器抓不到，
//    只能校验"前缀对应的对象存在"，否则整个家族都会退化成原始 key。
const templatePrefixPattern = /\bt\(`([a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*\.)\$\{/g;
const prefixes = new Map();
for (const file of walk(path.join(ROOT, 'client/src'))) {
  const src = fs.readFileSync(file, 'utf8');
  for (const match of src.matchAll(templatePrefixPattern)) {
    if (!prefixes.has(match[1])) prefixes.set(match[1], path.relative(ROOT, file));
  }
}
for (const [prefix, file] of prefixes) {
  const node = prefix
    .replace(/\.$/, '')
    .split('.')
    .reduce((acc, seg) => (acc && typeof acc === 'object' ? acc[seg] : undefined), en);
  if (!node || typeof node !== 'object' || Object.keys(node).length === 0) {
    missing.set(prefix + '*', file);
  }
}

// 4) 每个注册的提供商都要有 provider.<type>，否则徽标会显示成 provider.xxx
const registrySrc = fs.readFileSync(
  path.join(ROOT, 'server/src/lib/dns/providers/registry.ts'),
  'utf8',
);
for (const match of registrySrc.matchAll(/^ {4}type: '([a-z0-9_]+)',$/gm)) {
  const key = `provider.${match[1]}`;
  if (resolve(key) === undefined) missing.set(key, 'server/src/lib/dns/providers/registry.ts');
}

if (missing.size > 0) {
  console.error('以下 i18n key 在界面上会原样显示（en.json 里没有）：');
  for (const [key, file] of [...missing.entries()].sort()) {
    console.error(`  ${key}  <- ${file}`);
  }
  process.exit(1);
}

console.log('All referenced i18n keys resolve.');
