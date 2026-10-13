/**
 * 系统初始化状态与初始化入口开放策略。
 *
 * 关键不变量：
 * 1. 「数据库不可达」绝不等同于「系统未初始化」——前者是故障，后者是首次部署。
 * 2. 系统一旦确认已初始化，就不会因后续数据库抖动而回退为未初始化状态，
 *    否则初始化入口会被重新打开，形成未授权接管通道。
 * 3. 初始状态默认为「不可达」，即 fail-closed：首次探测完成前初始化入口保持关闭。
 * 4. 「是否曾初始化过」通过磁盘标记文件持久化，不依赖数据库连接状态——
 *    否则进程重启且数据库恰好不可达时，初始化入口会被重新打开。
 */

import fs from 'fs';
import path from 'path';
import { probeDbInitialization, type DbInitializationState } from '../db/connection';
import { createLogger } from '../lib/logger';

const log = createLogger('Server').sub('SystemState');

/**
 * 初始化完成标记文件路径。
 * 默认位于 `<cwd>/data/.initialized`，可用 `HIDNS_INIT_MARKER` 覆盖（测试用）。
 */
function markerPath(): string {
  return process.env.HIDNS_INIT_MARKER || path.resolve(process.cwd(), 'data', '.initialized');
}

function markerExists(): boolean {
  try {
    return fs.existsSync(markerPath());
  } catch {
    return false;
  }
}

function writeMarker(): void {
  try {
    const target = markerPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${new Date().toISOString()}\n`, 'utf8');
    log.info('Initialization marker written', { path: target });
  } catch (error) {
    log.error('Failed to write initialization marker', { error });
  }
}

// 启动即读取标记：已完成初始化的实例在重启后仍保持 fail-closed
let initialized = markerExists();
let lastProbe: DbInitializationState = 'unreachable';

if (initialized) {
  log.info('Initialization marker found; setup surface stays closed even if the database is unreachable', {
    path: markerPath(),
  });
}

/** 系统是否已初始化（用于初始化检查中间件） */
export function isSystemInitialized(): boolean {
  return initialized;
}

/** 最近一次探测结果 */
export function getLastProbe(): DbInitializationState {
  return lastProbe;
}

/**
 * 初始化入口是否允许开放。
 * 仅当系统**尚未初始化**且数据库**可达且确实未初始化**时才允许；其余一律关闭。
 */
export function isInitSurfaceOpen(): boolean {
  return !initialized && lastProbe === 'uninitialized';
}

/** 运行在临时内存库模式（首次引导、尚未配置真实数据库） */
export function isTempDbMode(): boolean {
  return process.env._TEMP_DB === '1';
}

/**
 * 重新探测并刷新系统状态。
 * 仅在探测到 `initialized` 时提升状态；`unreachable` 不会使已初始化系统降级。
 */
export async function refreshSystemState(): Promise<DbInitializationState> {
  const state = await probeDbInitialization();

  if (state !== lastProbe) {
    log.info('Database initialization state changed', { from: lastProbe, to: state });
  }
  lastProbe = state;

  if (state === 'initialized') {
    initialized = true;
  } else if (state === 'unreachable' && initialized) {
    // 已初始化系统遇到数据库故障：保持已初始化状态（降级，而非回退到初始化模式）
    log.warn('Database unreachable; keeping system in initialized mode (degraded)');
  } else if (state === 'uninitialized' && initialized) {
    // 标记文件存在但数据库看起来是空的：提示如何重新安装，而不是自动放开入口
    log.warn('Database looks uninitialized but the initialization marker exists. Delete the marker file to re-run setup.', {
      marker: markerPath(),
    });
  }

  return state;
}

/** 初始化流程确认落库成功后调用：置位内存标记并写入磁盘标记 */
export function markInitialized(): void {
  initialized = true;
  lastProbe = 'initialized';
  writeMarker();
}
