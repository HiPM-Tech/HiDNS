import { ProviderLineOperations } from '../db/bal/provider-line-operations';
import { createLogger } from '../lib/logger';

const log = createLogger('Service').sub('ProviderLines');

/** 动态线路缓存 TTL：1 小时（成功拉取后） */
export const PROVIDER_LINES_TTL_MS = 3600_000;
/** 动态线路失败后的重试间隔：5 分钟 */
export const PROVIDER_LINES_RETRY_MS = 300_000;

export interface ProviderLine {
  id: string;
  name?: string;
}

/** 进程内失败时间表（重启后由任务重新拉取即可，不需要持久化） */
const failures = new Map<string, number>();

export function markProviderLinesFailed(providerType: string, at: number = Date.now()): void {
  failures.set(providerType, at);
}

export function clearProviderLinesFailure(providerType: string): void {
  failures.delete(providerType);
}

export function getProviderLinesFailureAt(providerType: string): number {
  return failures.get(providerType) ?? 0;
}

export function __resetProviderLineFailures(): void {
  failures.clear();
}

/** 动态拉取失败时对外只返回默认线路 */
export function defaultOnlyLines(defaultLine: string): ProviderLine[] {
  return [{ id: defaultLine, name: '默认' }];
}

function parseDbTime(value: string | null): number {
  if (!value) return 0;
  // SQLite CURRENT_TIMESTAMP 是 UTC 且形如 'YYYY-MM-DD HH:MM:SS'
  const iso = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

export function isProviderLinesCacheFresh(updatedAt: string | null, now: number = Date.now()): boolean {
  const ts = parseDbTime(updatedAt);
  return ts > 0 && now - ts < PROVIDER_LINES_TTL_MS;
}

export interface ProviderLinesResult {
  lines: ProviderLine[];
  source: 'cache' | 'live' | 'default';
}

/**
 * 动态线路的统一读取：缓存（3600s）→ 拉取 → 失败只返回默认线路并进入 5 分钟冷却。
 * 内置线路不经过这里（见 DnsProviderService.getLines）。
 */
export async function getProviderLinesCached(params: {
  providerType: string;
  defaultLine: string;
  fetchLines: () => Promise<ProviderLine[]>;
  now?: number;
}): Promise<ProviderLinesResult> {
  const now = params.now ?? Date.now();
  const cached = await ProviderLineOperations.getByProvider(params.providerType);
  const updatedAt = cached[0]?.updated_at ?? null;
  if (cached.length > 0 && isProviderLinesCacheFresh(updatedAt, now)) {
    return { lines: cached.map((row) => ({ id: row.line_id, name: row.line_name })), source: 'cache' };
  }

  const failedAt = failures.get(params.providerType) ?? 0;
  if (failedAt > 0 && now - failedAt < PROVIDER_LINES_RETRY_MS) {
    return { lines: defaultOnlyLines(params.defaultLine), source: 'default' };
  }

  try {
    const lines = await params.fetchLines();
    const normalized = lines.filter((line) => String(line.id ?? '').trim());
    if (normalized.length === 0) throw new Error('上游返回空线路列表');
    await ProviderLineOperations.replaceForProvider(params.providerType, normalized);
    failures.delete(params.providerType);
    return { lines: normalized, source: 'live' };
  } catch (error) {
    failures.set(params.providerType, now);
    log.warn('Provider lines fetch failed; serving default only', {
      providerType: params.providerType,
      error: error instanceof Error ? error.message : String(error),
    });
    return { lines: defaultOnlyLines(params.defaultLine), source: 'default' };
  }
}

export interface RefreshCandidateInput {
  accounts: Array<{ type: string; enabled?: boolean | number }>;
  cacheUpdatedAt: Map<string, string | null>;
  now?: number;
}

/**
 * 任务筛选：只为「有启用账号」的提供商拉线路；缓存新鲜或失败冷却中则跳过。
 * 纯函数，便于单测（PSL 与线路任务共用 taskManager 约束）。
 */
export function selectProvidersToRefresh(input: RefreshCandidateInput): string[] {
  const now = input.now ?? Date.now();
  const types = new Set(
    input.accounts
      .filter((account) => account.enabled === undefined || account.enabled === 1 || account.enabled === true)
      .map((account) => account.type),
  );
  const out: string[] = [];
  for (const type of types) {
    const updatedAt = input.cacheUpdatedAt.get(type) ?? null;
    if (isProviderLinesCacheFresh(updatedAt, now)) continue;
    const failedAt = failures.get(type) ?? 0;
    if (failedAt > 0 && now - failedAt < PROVIDER_LINES_RETRY_MS) continue;
    out.push(type);
  }
  return out.sort();
}
