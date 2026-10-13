import { GroupedDomainsCacheOperations, SystemCacheOperations } from '../db/bal/business-adapter';
import { createLogger } from '../lib/logger';
import { taskManager } from './taskManager';

const log = createLogger('Cache').sub('Grouped');
const CACHE_VERSION_KEY = 'grouped_cache_ver';
const CACHE_TTL_MS = 720 * 60 * 60 * 1000;

// ─── Read / Write ────────────────────────────────────────────────────────────

export async function getCachedGroupedData(userId: number, cacheType: 'domain' | 'account'): Promise<{ data: any[]; ver: number } | null> {
  const row = await GroupedDomainsCacheOperations.get(userId, cacheType);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.cacheData);
    return { data: parsed, ver: row.version };
  } catch {
    await GroupedDomainsCacheOperations.delete(userId, cacheType);
    return null;
  }
}

export async function setCachedGroupedData(userId: number, cacheType: 'domain' | 'account', ver: number, data: any[]): Promise<void> {
  const expiresAt = new Date(Date.now() + CACHE_TTL_MS);
  await GroupedDomainsCacheOperations.set(userId, cacheType, ver, JSON.stringify(data), expiresAt);
}

export async function getCacheVersion(): Promise<number> {
  const raw = await SystemCacheOperations.get(CACHE_VERSION_KEY);
  return raw ? parseInt(raw, 10) || 0 : 0;
}

export async function bumpCacheVersion(): Promise<number> {
  const ver = Date.now();
  await SystemCacheOperations.set(CACHE_VERSION_KEY, String(ver));
  return ver;
}

// ─── Incremental Update ──────────────────────────────────────────────────────

async function updateCachedList(userId: number, cacheType: 'domain' | 'account', change: { type: 'create' | 'update' | 'delete'; item: any }): Promise<void> {
  const cached = await getCachedGroupedData(userId, cacheType);
  if (!cached) return;
  let { data } = cached;
  if (change.type === 'delete') {
    data = data.filter((d: any) => d.id !== change.item.id);
  } else if (change.type === 'create') {
    data = [...data, change.item];
  } else if (change.type === 'update') {
    data = data.map((d: any) => d.id === change.item.id ? change.item : d);
  }
  const ver = await bumpCacheVersion();
  await setCachedGroupedData(userId, cacheType, ver, data);
}

export function submitGroupedCacheUpdate(userId: number, cacheType: 'domain' | 'account', change: { type: 'create' | 'update' | 'delete'; item: any }): void {
  taskManager.submit(
    {
      id: `grouped-cache-update-${cacheType}-${userId}-${change.type}-${Date.now()}`,
      name: `Update ${cacheType} cache (${change.type}) for user ${userId}`,
      concurrency: 1,
      timeout: 30000,
    },
    () => updateCachedList(userId, cacheType, change),
  ).catch((err: Error) => log.warn('Cache update task failed', { error: err }));
}

// ─── Periodic Full Refresh ───────────────────────────────────────────────────

async function refreshGroupedCaches(): Promise<void> {
  log.info('Starting periodic grouped cache refresh');
  const ver = await bumpCacheVersion();
  log.info('Cache version bumped', { ver });
}

export function startGroupedCacheRefreshJob(): void {
  log.info('Starting grouped cache refresh job (interval: 30min)');

  // 首次运行：延迟 30 秒执行一次。
  // 必须放在本函数内（而非模块作用域）——模块级 setTimeout 会在导入时即注册，
  // 使得系统尚未初始化、甚至数据库不可达时也去执行数据库操作。
  const initialTimer = setTimeout(() => {
    taskManager.submit(
      {
        id: 'grouped-cache-refresh-initial',
        name: 'Initial grouped cache refresh',
        concurrency: 1,
        timeout: 60000,
      },
      refreshGroupedCaches,
    ).catch((err: Error) => log.warn('Initial grouped cache refresh failed', { error: err }));
  }, 30000);
  if (typeof initialTimer.unref === 'function') initialTimer.unref();

  setInterval(() => {
    taskManager.submit(
      {
        id: 'grouped-cache-refresh',
        name: 'Grouped cache refresh',
        concurrency: 1,
        timeout: 60000,
      },
      refreshGroupedCaches,
    ).catch((err: Error) => log.warn('Grouped cache refresh task failed', { error: err }));
  }, 30 * 60 * 1000);
}
