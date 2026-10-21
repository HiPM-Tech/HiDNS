import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSeaConfig, isCrossArchBuild } from './sea-config.mjs';

const BASE = {
  main: 'dist/bundle.cjs',
  output: 'dist/sea-prep.blob',
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: true,
};

test('同架构的 Linux 构建不改动 useCodeCache', () => {
  const { config, modified } = resolveSeaConfig(BASE, { isCrossArch: false, nodePlatform: 'linux' });
  assert.equal(modified, false);
  assert.equal(config.useCodeCache, true);
});

test('跨架构构建必须关闭 useCodeCache', () => {
  const { config, modified, reason } = resolveSeaConfig(BASE, { isCrossArch: true, nodePlatform: 'linux' });
  assert.equal(modified, true);
  assert.equal(config.useCodeCache, false);
  assert.match(String(reason), /arch specific/i);
});

test('macOS 目标即使同架构也要关闭 useCodeCache（实测启动即 segfault）', () => {
  const { config, modified, reason } = resolveSeaConfig(BASE, { isCrossArch: false, nodePlatform: 'darwin' });
  assert.equal(modified, true);
  assert.equal(config.useCodeCache, false);
  assert.match(String(reason), /macOS/);
});

test('macOS + 跨架构同样关闭', () => {
  const { config, modified } = resolveSeaConfig(BASE, { isCrossArch: true, nodePlatform: 'darwin' });
  assert.equal(modified, true);
  assert.equal(config.useCodeCache, false);
});

test('不改动原对象', () => {
  const input = { ...BASE };
  resolveSeaConfig(input, { isCrossArch: true, nodePlatform: 'darwin' });
  assert.equal(input.useCodeCache, true, '原始配置不应被就地修改');
});

test('本来就没开 useCodeCache 时不算改动', () => {
  const { modified } = resolveSeaConfig({ ...BASE, useCodeCache: false }, { isCrossArch: true, nodePlatform: 'darwin' });
  assert.equal(modified, false);
});

test('跨架构判定：平台不同也算跨架构', () => {
  assert.equal(isCrossArchBuild({ nodeArch: 'x64', nodePlatform: 'darwin' }, { arch: 'x64', platform: 'linux' }), true);
  assert.equal(isCrossArchBuild({ nodeArch: 'arm64', nodePlatform: 'darwin' }, { arch: 'x64', platform: 'darwin' }), true);
  assert.equal(isCrossArchBuild({ nodeArch: 'arm64', nodePlatform: 'darwin' }, { arch: 'arm64', platform: 'darwin' }), false);
});
