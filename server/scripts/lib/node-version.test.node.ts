import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MIN_SECURE_NODE_VERSION, NODE_SEA_VERSION, isAtLeast, parseNodeVersion } from './node-version.mjs';

test('打包的 Node 版本不低于安全底线', () => {
  // 低于底线意味着重新引入 CVE-2026-111497 / 105483 / 106069 / 106074 等
  assert.ok(
    isAtLeast(NODE_SEA_VERSION, MIN_SECURE_NODE_VERSION),
    `当前 ${NODE_SEA_VERSION} 低于安全底线 ${MIN_SECURE_NODE_VERSION}`,
  );
});

test('版本比较按语义化逐段进行，不是字符串比较', () => {
  // 字符串比较会把 v24.9.0 判成大于 v24.22.1
  assert.equal(isAtLeast('v24.9.0', 'v24.22.1'), false);
  assert.equal(isAtLeast('v24.22.1', 'v24.22.1'), true);
  assert.equal(isAtLeast('v24.23.0', 'v24.22.1'), true);
  assert.equal(isAtLeast('v25.0.0', 'v24.22.1'), true);
});

test('拒绝无法解析的版本串', () => {
  assert.equal(parseNodeVersion('24.22'), null);
  assert.equal(parseNodeVersion('node'), null);
  assert.equal(isAtLeast('', MIN_SECURE_NODE_VERSION), false);
});

test('工作流里的 NODE_SEA_VERSION 与代码中的常量一致', () => {
  // 两处各写一遍，最容易在升级时漏掉一处；这里把它锁住
  const workflow = fs.readFileSync(
    path.resolve(import.meta.dirname, '../../../.github/workflows/release.yml'),
    'utf8',
  );
  const match = /^\s*NODE_SEA_VERSION:\s*(\S+)\s*$/m.exec(workflow);
  assert.ok(match, 'release.yml 里没有 NODE_SEA_VERSION');
  assert.equal(match[1], NODE_SEA_VERSION);
});
