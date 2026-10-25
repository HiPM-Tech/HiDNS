import { createLogger } from '../lib/logger';
import { loadPublicSuffixesFromDb, refreshPublicSuffixes } from './public-suffix';
import { taskManager } from './taskManager';

const log = createLogger('Job').sub('PublicSuffix');

let timer: NodeJS.Timeout | null = null;
let started = false;

/** 与线路刷新共用 taskManager 约束（并发/超时/同 ID 去重），避免两个外部拉取任务互相踩踏 */
function submitRefresh(): void {
  void taskManager
    .submit(
      { id: 'public-suffix-refresh', name: 'Refresh public suffix list', concurrency: 1, timeout: 120_000 },
      async () => { await refreshPublicSuffixes(); },
    )
    .catch((error: Error) => log.warn('Public suffix refresh failed', { error: error.message }));
}

/**
 * 公共后缀定时任务。
 *
 * 启动时：先从 DB 载入内置/已有后缀（同步可用），再异步拉一次上游（失败不影响启动）。
 * 之后：每 `PUBLIC_SUFFIX_REFRESH_DAYS`（默认 7 天）刷新一次。
 * 为什么要定时：新增 TLD 与多段后缀（.zip、dpdns.org 这类）会持续出现，
 * 写死在代码里意味着每次都要发版；入库后重启都不用。
 */
export function startPublicSuffixJob(): void {
  if (started) return;
  started = true;

  void (async () => {
    await loadPublicSuffixesFromDb();
    const days = Math.max(1, Number(process.env.PUBLIC_SUFFIX_REFRESH_DAYS ?? 7) || 7);
    const intervalMs = days * 24 * 60 * 60 * 1000;

    // 首次拉取：延迟 30s，避开启动高峰（初始化门禁、迁移、其它任务都在抢资源）
    setTimeout(() => { submitRefresh(); }, 30_000);

    if (timer) clearInterval(timer);
    timer = setInterval(() => { submitRefresh(); }, intervalMs);
    log.info('Public suffix job started', { refreshDays: days });
  })().catch((error) => log.error('Failed to start public suffix job', { error }));
}

/** 测试与优雅退出用 */
export function stopPublicSuffixJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}
