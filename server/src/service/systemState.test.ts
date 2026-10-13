/**
 * systemState 状态机测试。
 *
 * 关键不变量：
 * 1. 首次探测前 fail-closed —— 初始化入口必须关闭。
 * 2. 「数据库不可达」不得被当作「未初始化」，否则会在故障期间开放初始化入口。
 * 3. 已初始化标记是粘性的 —— 数据库抖动不得使其回退。
 * 4. 「是否曾初始化过」由磁盘标记持久化 —— 进程重启且数据库不可达时仍 fail-closed。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({ value: 'unreachable' as string }));

vi.mock('../db/connection', () => ({
  probeDbInitialization: async () => probe.value,
}));

// 隔离标记文件，避免污染仓库与测试之间互相干扰
const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hidns-init-marker-'));
const markerFile = path.join(markerDir, '.initialized');
process.env.HIDNS_INIT_MARKER = markerFile;

async function freshModule() {
  vi.resetModules();
  return await import('./systemState');
}

afterAll(() => {
  try { fs.rmSync(markerDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('systemState 初始化状态机', () => {
  beforeEach(() => {
    probe.value = 'unreachable';
    try { fs.rmSync(markerFile, { force: true }); } catch { /* ignore */ }
  });

  it('首次探测前 fail-closed：入口保持关闭', async () => {
    const m = await freshModule();
    expect(m.isSystemInitialized()).toBe(false);
    expect(m.isInitSurfaceOpen()).toBe(false);
  });

  it('unreachable 不被当作 uninitialized', async () => {
    const m = await freshModule();
    probe.value = 'unreachable';

    expect(await m.refreshSystemState()).toBe('unreachable');
    expect(m.isSystemInitialized()).toBe(false);
    // 关键断言：数据库不可达时初始化入口必须关闭
    expect(m.isInitSurfaceOpen()).toBe(false);
  });

  it('仅当“可达且未初始化”时才开放初始化入口', async () => {
    const m = await freshModule();

    probe.value = 'uninitialized';
    expect(await m.refreshSystemState()).toBe('uninitialized');
    expect(m.isInitSurfaceOpen()).toBe(true);
    expect(m.isSystemInitialized()).toBe(false);
  });

  it('已初始化标记是粘性的：数据库故障后不回退，入口保持关闭', async () => {
    const m = await freshModule();

    probe.value = 'initialized';
    expect(await m.refreshSystemState()).toBe('initialized');
    expect(m.isSystemInitialized()).toBe(true);

    // 数据库故障
    probe.value = 'unreachable';
    expect(await m.refreshSystemState()).toBe('unreachable');

    // 不得回退为未初始化，入口不得重新打开
    expect(m.isSystemInitialized()).toBe(true);
    expect(m.isInitSurfaceOpen()).toBe(false);

    // 故障恢复后仍为已初始化
    probe.value = 'initialized';
    await m.refreshSystemState();
    expect(m.isSystemInitialized()).toBe(true);
  });

  it('markInitialized 立即关闭初始化入口并落盘标记', async () => {
    const m = await freshModule();

    probe.value = 'uninitialized';
    await m.refreshSystemState();
    expect(m.isInitSurfaceOpen()).toBe(true);

    m.markInitialized();
    expect(m.isSystemInitialized()).toBe(true);
    expect(m.isInitSurfaceOpen()).toBe(false);
    expect(fs.existsSync(markerFile)).toBe(true);
  });

  it('进程重启后（标记存在）即使数据库不可达也保持 fail-closed', async () => {
    // 模拟上一次运行已完成初始化：标记已落盘
    fs.writeFileSync(markerFile, new Date().toISOString(), 'utf8');

    // 模拟重启：重新加载模块，且数据库不可达
    probe.value = 'unreachable';
    const m = await freshModule();

    expect(m.isSystemInitialized()).toBe(true);
    expect(m.isInitSurfaceOpen()).toBe(false);

    // 重启后首次探测仍为不可达，入口依然关闭
    expect(await m.refreshSystemState()).toBe('unreachable');
    expect(m.isInitSurfaceOpen()).toBe(false);
  });
});
