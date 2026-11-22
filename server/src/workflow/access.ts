import { DomainOperations } from '../db/bal/business-adapter';
import { createLogger } from '../lib/logger';

const log = createLogger('Workflow').sub('Access');

/**
 * 用户可访问域名 ID 集合（工作流执行身份与引擎租户过滤共用）。
 *
 * 依据：`DomainOperations.getUserAccessibleDomains` 已按 `dns_accounts.created_by`
 * 与 `domain_permissions` 过滤 —— 这是项目既有的权限模型，不得绕开。
 *
 * 缓存 60 秒：引擎每个事件都要判定租户边界，直连数据库会退化为每事件一次查询。
 * 缓存仅在**本进程**内，多实例部署时最长滞后 60 秒。
 */

const TTL_MS = 60_000;
interface AccessSet {
  ids: number[];
  names: string[];
  at: number;
}
const cache = new Map<number, AccessSet>();
const EMPTY: AccessSet = { ids: [], names: [], at: 0 };

/**
 * 过期条目清理 + 条目数上限。
 *
 * 原来只按 TTL 判断「是否命中」，过期条目本身从不删除：
 * 活跃用户越多，Map 越大，而且每条都带完整的域名 id/name 列表 ——
 * 长期运行时这部分内存只增不减，属于典型的「看起来有 TTL、实际没有回收」。
 */
function sweepExpired<V extends { at: number }>(map: Map<number, V>, ttlMs: number, maxEntries: number): void {
  const now = Date.now();
  for (const [key, value] of map) {
    if (now - value.at >= ttlMs) map.delete(key);
  }
  if (map.size <= maxEntries) return;
  // 仍超上限时按 at 从旧到新淘汰（简单 LRU 近似）
  const sorted = [...map.entries()].sort((a, b) => a[1].at - b[1].at);
  for (let i = 0; i < sorted.length - maxEntries; i += 1) map.delete(sorted[i][0]);
}

const ACCESS_CACHE_MAX = 500;

export async function getAccessibleDomains(userId: number): Promise<{ ids: number[]; names: string[] }> {
  if (!Number.isFinite(userId) || userId <= 0) return { ids: [], names: [] };
  const now = Date.now();
  const hit = cache.get(userId);
  if (hit && now - hit.at < TTL_MS) return hit;

  try {
    const rows = (await DomainOperations.getUserAccessibleDomains(userId)) as unknown as Array<{
      id: number;
      name: string;
    }>;
    const entry: AccessSet = {
      ids: rows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id)),
      names: rows.map((row) => String(row.name)).filter(Boolean),
      at: now,
    };
    cache.set(userId, entry);
    sweepExpired(cache, TTL_MS, ACCESS_CACHE_MAX);
    return entry;
  } catch (error) {
    // fail-closed：查不出可访问域名时返回空集，宁可不执行
    log.error('getUserAccessibleDomains failed', { userId, error: (error as Error).message });
    return EMPTY;
  }
}

export async function getAccessibleDomainIds(userId: number): Promise<number[]> {
  return (await getAccessibleDomains(userId)).ids;
}

const writeCache = new Map<number, { ids: number[]; at: number }>();

/** 可写域名集合：只读授权（permission='read' 或限定 sub）不在此列 */
export async function getWritableDomainIds(userId: number): Promise<number[]> {
  if (!Number.isFinite(userId) || userId <= 0) return [];
  const now = Date.now();
  const hit = writeCache.get(userId);
  if (hit && now - hit.at < TTL_MS) return hit.ids;
  try {
    const ids = await DomainOperations.getWritableDomainIds(userId);
    writeCache.set(userId, { ids, at: now });
    sweepExpired(writeCache, TTL_MS, ACCESS_CACHE_MAX);
    return ids;
  } catch (error) {
    log.error('getWritableDomainIds failed', { userId, error: (error as Error).message });
    return [];
  }
}

export function invalidateAccessCache(userId?: number): void {
  if (userId === undefined) {
    cache.clear();
    writeCache.clear();
    return;
  }
  cache.delete(userId);
  writeCache.delete(userId);
}