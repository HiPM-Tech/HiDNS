import { DnsAccountOperations, DomainOperations } from '../db/bal/business-adapter';
import { ProviderLineOperations } from '../db/bal/provider-line-operations';
import { getProviderDefinitions } from '../lib/dns/providers/registry';
import { createLogger } from '../lib/logger';
import { DnsProviderService } from './dns-provider-service';
import {
  clearProviderLinesFailure,
  markProviderLinesFailed,
  selectProvidersToRefresh,
} from './providerLines';
import { taskManager } from './taskManager';

const log = createLogger('Job').sub('ProviderLines');

/** 轮询间隔：每 60s 检查一次；过期（3600s）/失败冷却（300s）由 selectProvidersToRefresh 判定 */
const TICK_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let started = false;

export async function refreshProviderLinesOnce(): Promise<string[]> {
  const accounts = await DnsAccountOperations.getAll() as unknown as Array<{ id: number; type: string; enabled?: boolean | number }>;
  const types = [...new Set(accounts.map((account) => account.type))];
  const cacheUpdatedAt = new Map<string, string | null>();
  for (const type of types) {
    cacheUpdatedAt.set(type, await ProviderLineOperations.getLastUpdatedAt(type));
  }

  const targets = selectProvidersToRefresh({ accounts, cacheUpdatedAt }).filter((type) => {
    const definition = getProviderDefinitions().find((item) => item.type === type);
    return definition?.lineSource === 'dynamic';
  });

  for (const type of targets) {
    const account = accounts.find((item) => item.type === type && (item.enabled === undefined || item.enabled === 1 || item.enabled === true));
    if (!account) continue;
    void taskManager.submit(
      { id: `provider-lines-${type}`, name: `Refresh provider lines: ${type}`, concurrency: 2, timeout: 120_000 },
      async () => {
        const domains = await DomainOperations.getByAccountId(account.id) as unknown as Array<{ name?: string; third_id?: string }>;
        const domain = domains[0];
        const adapter = await DnsProviderService.getAdapterByAccount(account.id, domain?.name ?? '', domain?.third_id ?? '');
        const lines = await adapter.getRecordLines();
        if (lines.length === 0) throw new Error('上游返回空线路列表');
        await ProviderLineOperations.replaceForProvider(type, lines);
        clearProviderLinesFailure(type);
        log.info('Provider lines refreshed', { providerType: type, count: lines.length });
      },
    ).catch((error: Error) => {
      markProviderLinesFailed(type);
      log.warn('Provider lines refresh failed; retry in 5 minutes', { providerType: type, error: error.message });
    });
  }
  return targets;
}

/**
 * 线路刷新任务（与 PSL 共用 taskManager 约束）。
 * 只处理「有启用账号」的提供商；动态提供商才拉取。
 */
export function startProviderLinesJob(): void {
  if (started) return;
  started = true;
  // 首次延迟 25s，避开启动高峰（与 PSL 的 30s 首次拉取相邻但不重叠）
  setTimeout(() => { void refreshProviderLinesOnce().catch((error) => log.warn('Initial provider lines refresh failed', { error })); }, 25_000);
  timer = setInterval(() => {
    void refreshProviderLinesOnce().catch((error) => log.warn('Provider lines refresh tick failed', { error }));
  }, TICK_MS);
  log.info('Provider lines job started', { tickMs: TICK_MS });
}

export function stopProviderLinesJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}
