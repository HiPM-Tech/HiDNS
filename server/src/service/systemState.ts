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
import { resolveDataDir } from '../db/dal/config';
import { createLogger } from '../lib/logger';

const log = createLogger('Server').sub('SystemState');

/**
 * 初始化完成标记的候选路径（按优先级）。
 *
 * - 首选：数据目录下的 `.initialized`（与数据库同源，见 `resolveDataDir()`）；
 * - 兼容：历史版本写在 `<cwd>/data/.initialized`，仍会被读取，避免升级后丢失「已初始化」状态；
 * - 测试：`HIDNS_INIT_MARKER` 覆盖全部候选。
 */
/**
 * 历史标记是否可信：必须是「旧版布局」——`<cwd>/data` 下确实还放着 sqlite 库文件。
 *
 * 不加这条时，开发/测试机器上残留的 `server/data/.initialized` 会让**全新数据库**
 * 被判定为「已初始化」（E2E 走查中：全新 /tmp 库首次「测试连接」就提示「检测到已有数据」
 * 并给出「重置并初始化」危险入口）。旧版升级场景里 data 目录一定有库文件，因此不影响兼容。
 */
function legacyMarkerPlausible(): boolean {
  const legacyDir = path.resolve(process.cwd(), 'data');
  const legacyMarker = path.join(legacyDir, '.initialized');
  if (!fs.existsSync(legacyMarker)) return false;
  // 只有「当前配置的数据库也在 data 目录里」时，旧标记才属于这套数据；
  // 否则开发机上残留的 data/hidns.db + 标记会让全新的外部库被误判为已初始化。
  const configuredDb = process.env.DB_PATH;
  if (configuredDb && configuredDb !== ':memory:') {
    const resolvedDb = path.resolve(process.cwd(), configuredDb);
    if (!resolvedDb.startsWith(legacyDir + path.sep)) return false;
  }
  try {
    return fs.readdirSync(legacyDir).some((file) => /\.(db|sqlite|sqlite3)$/i.test(file));
  } catch {
    return false;
  }
}

function markerCandidates(): string[] {
  const override = process.env.HIDNS_INIT_MARKER;
  if (override) return [override];
  const primary = path.join(resolveDataDir(), '.initialized');
  const legacy = path.resolve(process.cwd(), 'data', '.initialized');
  if (primary === legacy) return [primary];
  return legacyMarkerPlausible() ? [primary, legacy] : [primary];
}

/** 首选（写入用）标记路径 */
export function markerPath(): string {
  return markerCandidates()[0];
}

function markerExists(): boolean {
  return markerCandidates().some((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
}

/** 写入标记；返回是否真的落盘（调用方必须能区分「已落盘」与「仅内存」） */
function writeMarker(): boolean {
  const target = markerPath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${new Date().toISOString()}\n`, 'utf8');
    log.info('Initialization marker written', { path: target });
    return true;
  } catch (error) {
    log.error('Failed to write initialization marker; initialization state is memory-only', {
      path: target,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return false;
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
    // 标记与库矛盾：库**可达**但没有用户（不是抖动，也不是不可达）。
    // 若继续 fail-closed，实例会永久卡在「初始化完成」状态：/init/admin 403、业务接口 401，
    // 谁都进不去（架构测试 A2 实测）。而「没有用户」意味着不存在可被接管的账号，
    // 因此这里放开初始化面，同时保留标记文件供审计。
    log.error('Initialization marker exists but database has no users; reopening setup surface', {
      marker: markerPath(),
    });
    initialized = false;
  }

  return state;
}

/**
 * 初始化流程确认落库成功后调用：置位内存标记并写入磁盘标记。
 * @returns 标记是否成功落盘；false 表示当前进程重启后可能丢失「已初始化」状态。
 */
export function markInitialized(): boolean {
  initialized = true;
  lastProbe = 'initialized';
  return writeMarker();
}
