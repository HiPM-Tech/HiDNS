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

export function invalidateAccessCache(userId?: number): void {
  if (userId === undefined) cache.clear();
  else cache.delete(userId);
}