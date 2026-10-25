import { GroupedDomainsCacheOperations, SystemCacheOperations } from '../db/bal/business-adapter';
import { createLogger } from '../lib/logger';
import { taskManager } from './taskManager';

const log = createLogger('Cache').sub('Grouped');
const CACHE_VERSION_KEY = 'grouped_cache_ver';
const CACHE_TTL_MS = 720 * 60 * 60 * 1000;

// ─── Read / Write ────────────────────────────────────────────────────────────

/**
 * 进程内一层「已解析」缓存。
 *
 * DB 里存的是 JSON 字符串，1.3MB 的数据每次命中都要 JSON.parse（分组视图比非分组慢 4.8 倍）。
 * 这里按 userId+type+version 缓存解析结果，版本一变自然失效；上限 50 条避免多租户撑爆内存。
 */
const parsedCache = new Map<string, any[]>();
const PARSED_CACHE_LIMIT = 50;

function rememberParsed(key: string, data: any[]): void {
  if (parsedCache.size >= PARSED_CACHE_LIMIT && !parsedCache.has(key)) {
    const firstKey = parsedCache.keys().next().value;
    if (firstKey !== undefined) parsedCache.delete(firstKey);
  }
  parsedCache.set(key, data);
}

/** 供测试与运维使用 */
export function clearParsedCache(): void {
  parsedCache.clear();
}

export async function getCachedGroupedData(userId: number, cacheType: 'domain' | 'account'): Promise<{ data: any[]; ver: number } | null> {
  const row = await GroupedDomainsCacheOperations.get(userId, cacheType);
  if (!row) return null;
  const ver = Number(row.version);
  const memoryKey = `${userId}:${cacheType}:${ver}`;
  const memoryHit = parsedCache.get(memoryKey);
  if (memoryHit) return { data: memoryHit, ver };
  try {
    const parsed = JSON.parse(row.cacheData);
    rememberParsed(memoryKey, parsed);
    // SQLite 会把大整数按 REAL 存成 "1792834075230.0" 这类文本，读回来可能是 string；
    // 不归一化就会与 getCacheVersion() 的 number 用 === 比较而**永远不相等**（命中率 0）。
    return { data: parsed, ver };
  } catch {
    await GroupedDomainsCacheOperations.delete(userId, cacheType);
    return null;
  }
}

export async function setCachedGroupedData(userId: number, cacheType: 'domain' | 'account', ver: number, data: any[]): Promise<void> {
  rememberParsed(`${userId}:${cacheType}:${Number(ver)}`, data);
  const expiresAt = new Date(Date.now() + CACHE_TTL_MS);
  await GroupedDomainsCacheOperations.set(userId, cacheType, ver, JSON.stringify(data), expiresAt);
}

export async function getCacheVersion(): Promise<number> {
  const raw = await SystemCacheOperations.get(CACHE_VERSION_KEY);
  if (raw === null || raw === undefined || raw === '') return 0;
  // 同上：Number() 能吃 "1792834075230.0"，parseInt 也能，但两者混用会出现类型不一致
  const parsed = Number(String(raw).trim());
  return Number.isFinite(parsed) ? parsed : 0;
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
  // 清掉该用户旧版本的内存解析缓存，避免读到写前数据
  for (const key of parsedCache.keys()) {
    if (key.startsWith(`${userId}:${cacheType}:`)) parsedCache.delete(key);
  }
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
  // 之前只 bump 版本、没有任何人重建缓存：下一次请求全部未命中，
  // 等于把「刷新」变成了「集体失效」。这里改成清空缓存行 + bump，
  // 由后续请求按需重建（每用户一次全量查询，而不是每次请求都打库）。
  const cleared = await GroupedDomainsCacheOperations.clearAll();
  clearParsedCache();
  const ver = await bumpCacheVersion();
  log.info('Grouped cache cleared and version bumped', { cleared, ver });
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
