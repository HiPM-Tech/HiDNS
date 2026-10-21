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

test('同架构构建不改动 useCodeCache', () => {
  const { config, modified } = resolveSeaConfig(BASE, { isCrossArch: false });
  assert.equal(modified, false);
  assert.equal(config.useCodeCache, true);
});

test('跨架构构建必须关闭 useCodeCache', () => {
  const { config, modified, reason } = resolveSeaConfig(BASE, { isCrossArch: true });
  assert.equal(modified, true);
  assert.equal(config.useCodeCache, false);
  assert.match(String(reason), /arch specific/i);
});

test('不改动原对象', () => {
  const input = { ...BASE };
  resolveSeaConfig(input, { isCrossArch: true });
  assert.equal(input.useCodeCache, true, '原始配置不应被就地修改');
});

test('本来就没开 useCodeCache 时不算改动', () => {
  const { modified } = resolveSeaConfig({ ...BASE, useCodeCache: false }, { isCrossArch: true });
  assert.equal(modified, false);
});

test('跨架构判定：平台不同也算跨架构', () => {
  assert.equal(isCrossArchBuild({ nodeArch: 'x64', nodePlatform: 'darwin' }, { arch: 'x64', platform: 'linux' }), true);
  assert.equal(isCrossArchBuild({ nodeArch: 'arm64', nodePlatform: 'darwin' }, { arch: 'x64', platform: 'darwin' }), true);
  assert.equal(isCrossArchBuild({ nodeArch: 'arm64', nodePlatform: 'darwin' }, { arch: 'arm64', platform: 'darwin' }), false);
});
