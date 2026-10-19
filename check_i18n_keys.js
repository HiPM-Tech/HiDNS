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

if (missing.size > 0) {
  console.error('以下 i18n key 在界面上会原样显示（en.json 里没有）：');
  for (const [key, file] of [...missing.entries()].sort()) {
    console.error(`  ${key}  <- ${file}`);
  }
  process.exit(1);
}

console.log('All referenced i18n keys resolve.');
