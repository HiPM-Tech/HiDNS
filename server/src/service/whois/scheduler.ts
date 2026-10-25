/**
 * WHOIS 调度器注册表
 *
 * 所有支持 WHOIS 查询的 DNS 提供商需要实现此接口并向核心注册
 */

import { dnsheWhoisScheduler } from '../../lib/dns/providers';
import { createLogger } from '../../lib/logger';

const log = createLogger('WhoisService').sub('Scheduler');

/** 轮转游标：保证多次调度能覆盖全部域名（避免每次都只处理前 N 条） */
let whoisCursor = 0;

/**
 * 按游标轮转切分批次（纯函数，便于单测）。
 * 返回本轮切片与下一次的游标；列表较短时一次处理完并重置游标。
 */
export function sliceWhoisBatch<T>(domains: T[], limit: number, cursor: number): { batch: T[]; nextCursor: number } {
  if (limit <= 0) return { batch: [], nextCursor: cursor };
  if (domains.length <= limit) return { batch: domains, nextCursor: 0 };
  const start = cursor % domains.length;
  const head = domains.slice(start, start + limit);
  const tail = head.length < limit ? domains.slice(0, limit - head.length) : [];
  const batch = [...head, ...tail];
  return { batch, nextCursor: (start + batch.length) % domains.length };
}

/**
 * 初始化 WHOIS 调度器
 * 在应用启动时注册所有支持 WHOIS 的 DNS 提供商调度器
 */
export function initWhoisSchedulers(): void {
  const { initDnsProviderAdapters } = require('./methods/dns-provider.registry');
  initDnsProviderAdapters();

  log.info('Registered WHOIS adapters');
}

/**
 * 同步所有域名的 WHOIS 信息
 * @param forceRefresh 是否强制刷新（无视缓存）
 */
export async function syncAllDomainsWhois(forceRefresh: boolean = false): Promise<void> {
  const { WhoisOperations } = await import('../../db/bal/business-adapter');
  const { connect } = await import('../../db/dal/connection');
  const { taskManager } = await import('../taskManager');
  const { createLogger } = await import('../../lib/logger');
  const log = createLogger('WhoisService').sub('Scheduler');
  const { checkWhoisForDomain } = await import('./checker');
  const { checkAndSendNotification } = await import('./notifier');

  log.info('Starting WHOIS sync for all domains');

  let domains: any[] = [];
  try {
    domains = await WhoisOperations.getAllDomains();
  } catch (error) {
    if (error instanceof Error && error.message.includes('Database connection not initialized')) {
      log.warn('Database connection lost, attempting to reconnect...');
      try {
        await connect();
        log.info('Database reconnected successfully, retrying...');
        domains = await WhoisOperations.getAllDomains();
      } catch (reconnectError) {
        log.error('Failed to reconnect to database');
        return;
      }
    } else {
      throw error;
    }
  }

  log.info(`Found ${domains.length} domains to sync`);

  let successCount = 0;
  let failCount = 0;
  const failedDomains: string[] = [];

  // 队列保护：一次性把几千个域名塞进全局队列会饿死其它任务（缓存失效任务 2.5s 内 0 次调度，
  // 实测 5011 条 WHOIS 任务需要 2 小时排空）。每轮最多处理上限条，剩余下一轮继续。
  // 分片必须**轮转**：之前直接 slice(0,200) 且查询无排序，
  // 结果永远是同一批 id（实测 250 个域名时 201+ 永不处理）。
  // 这里用模块级游标按数组顺序切片，每轮从上次结束处继续，处理完一轮回到起点。
  const WHOIS_BATCH_LIMIT = Number(process.env.WHOIS_BATCH_LIMIT ?? 200) || 200;
  const sliced = sliceWhoisBatch(domains as unknown[], WHOIS_BATCH_LIMIT, whoisCursor);
  const batch = sliced.batch as typeof domains;
  whoisCursor = sliced.nextCursor;
  if (domains.length > batch.length) {
    log.warn('WHOIS batch sliced to protect task queue', { total: domains.length, processing: batch.length, limit: WHOIS_BATCH_LIMIT, nextCursor: whoisCursor });
  }

  const tasks = batch.map((d: any) => {
    return taskManager.submit(
      {
        id: `whois-${d.id}`,
        name: `WHOIS Sync: ${d.name}`,
        concurrency: 3,
        timeout: 60000,
        retries: 1,
        retryDelay: 5000,
      },
      async () => {
        try {
          // 跳过已禁用的域名
          if (d.enabled === 0) {
            log.info(`Skipping disabled domain: ${d.name}`);
            return;
          }

          const whoisResult = await checkWhoisForDomain(d.name, forceRefresh);

          if (whoisResult.expiryDate) {
            const year = whoisResult.expiryDate.getFullYear();
            const month = String(whoisResult.expiryDate.getMonth() + 1).padStart(2, '0');
            const day = String(whoisResult.expiryDate.getDate()).padStart(2, '0');
            const hours = String(whoisResult.expiryDate.getHours()).padStart(2, '0');
            const minutes = String(whoisResult.expiryDate.getMinutes()).padStart(2, '0');
            const seconds = String(whoisResult.expiryDate.getSeconds()).padStart(2, '0');
            const formattedDate = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

            const formattedApexDate = whoisResult.apexExpiryDate
              ? (() => {
                  const y = whoisResult.apexExpiryDate!.getFullYear();
                  const m = String(whoisResult.apexExpiryDate!.getMonth() + 1).padStart(2, '0');
                  const d = String(whoisResult.apexExpiryDate!.getDate()).padStart(2, '0');
                  const h = String(whoisResult.apexExpiryDate!.getHours()).padStart(2, '0');
                  const min = String(whoisResult.apexExpiryDate!.getMinutes()).padStart(2, '0');
                  const s = String(whoisResult.apexExpiryDate!.getSeconds()).padStart(2, '0');
                  return `${y}-${m}-${d} ${h}:${min}:${s}`;
                })()
              : null;

            await WhoisOperations.updateExpiry(d.id, formattedDate, formattedApexDate, whoisResult.status);

            successCount++;
            log.info(`Updated expiry for ${d.name}: ${formattedDate}`);

            // 推送 WebSocket 消息通知前端更新。
            // 必须按「能读到该域名的用户」定向推送：payload 带域名与到期时间，
            // 全局广播会把这些信息推给所有在线用户，等于跨用户外泄。
            try {
              const { wsService } = await import('../websocket');
              const { getDomainAudienceUserIds } = await import('../realtime-audience');
              const audience = await getDomainAudienceUserIds(Number(d.id));
              wsService.broadcastToUsers(audience, {
                type: 'domain_whois_updated',
                data: {
                  domainId: d.id,
                  name: d.name,
                  expiresAt: formattedDate,
                  apexExpiresAt: formattedApexDate,
                  whoisStatus: whoisResult.status,
                },
              });
            } catch (error) {
              log.error('Failed to send domain_whois_updated event', { error });
            }

            await checkAndSendNotification(d, whoisResult.expiryDate);
          } else {
            failCount++;
            failedDomains.push(d.name);
            log.warn(`Failed to get expiry for ${d.name}`);
          }
        } catch (error) {
          failCount++;
          failedDomains.push(d.name);
          log.error(`Error processing ${d.name}`);
        }
      }
    );
  });

  await Promise.all(tasks);

  log.info(`WHOIS sync completed: ${successCount} success, ${failCount} failed`, {
    failedDomains: failedDomains.slice(0, 20),
    totalFailed: failedDomains.length,
  });
}

/**
 * 启动 WHOIS 定时任务
 */
export async function startWhoisJob(): Promise<void> {
  const { WhoisOperations } = await import('../../db/bal/business-adapter');
  const { taskManager } = await import('../taskManager');
  const { createLogger } = await import('../../lib/logger');
  const log = createLogger('WhoisService').sub('Scheduler');

  // 初始化 WHOIS 缓存表
  try {
    await WhoisOperations.ensureWhoisCacheTable();
    log.info('WHOIS cache table initialized');
  } catch (error) {
    log.error('Failed to initialize WHOIS cache table');
  }

  // 启动后 30 秒运行第一次
  setTimeout(() => {
    taskManager.submit(
      {
        id: 'whois-sync-initial',
        name: 'WHOIS Initial Sync',
        concurrency: 3,
        timeout: 300000,
        retries: 1,
        retryDelay: 10000,
      },
      syncAllDomainsWhois
    ).catch(err => log.error('Initial sync error'));
  }, 30 * 1000);

  // 每小时运行一次
  setInterval(() => {
    taskManager.submit(
      {
        id: `whois-sync-${Date.now()}`,
        name: 'WHOIS Scheduled Sync',
        concurrency: 3,
        timeout: 300000,
        retries: 1,
        retryDelay: 10000,
      },
      syncAllDomainsWhois
    ).catch(err => log.error('Scheduled sync error'));
  }, 60 * 60 * 1000);

  log.info('WHOIS job scheduler started (every 1 hour)');
}
