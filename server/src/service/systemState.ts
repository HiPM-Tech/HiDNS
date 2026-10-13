/**
 * 系统初始化状态与初始化入口开放策略。
 *
 * 关键不变量：
 * 1. 「数据库不可达」绝不等同于「系统未初始化」——前者是故障，后者是首次部署。
 * 2. 系统一旦确认已初始化，就不会因后续数据库抖动而回退为未初始化状态，
 *    否则初始化入口会被重新打开，形成未授权接管通道。
 * 3. 初始状态默认为「不可达」，即 fail-closed：首次探测完成前初始化入口保持关闭。
 */

import { probeDbInitialization, type DbInitializationState } from '../db/connection';
import { createLogger } from '../lib/logger';

const log = createLogger('Server').sub('SystemState');

let initialized = false;
let lastProbe: DbInitializationState = 'unreachable';

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
 * 仅当数据库可达且确实处于「未初始化」状态时才允许；不可达一律关闭。
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
  }

  return state;
}

/** 初始化流程确认落库成功后调用 */
export function markInitialized(): void {
  initialized = true;
  lastProbe = 'initialized';
}
