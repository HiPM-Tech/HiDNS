/**
 * Domain Renewal Job Service
 * 域名续期定时任务服务 - 每天 UTC 0:00 自动续期
 * 支持所有注册了续期调度器的 DNS 提供商
 */

import { DnsAccountOperations, DomainOperations, RenewableDomainOperations } from '../db/bal/business-adapter';
import { publishDomainEvent } from '../lib/domain-event-bus';
import { whoisEventDedupe } from '../lib/whois-event-dedupe';
import { renewalRegistry } from './renewalScheduler';
import { taskManager } from './taskManager';
import { createLogger } from '../lib/logger';

const log = createLogger('Job').sub('DomainRenewal');
let renewalInterval: NodeJS.Timeout | null = null;

/**
 * 执行域名自动续期
 * 遍历所有 DNS 账号，对已注册续期调度器的提供商执行续期
 */
export async function executeDomainRenewal(): Promise<void> {
  try {
    log.info('Starting automatic domain renewal');

    // 获取所有 DNS 账号
    const accounts = await DnsAccountOperations.getAll() as any[];

    // 按提供商类型分组，只保留有续期调度器的
    const schedulableTypes = renewalRegistry.getRegisteredTypes();
    const targetAccounts = accounts.filter((acc: any) => schedulableTypes.includes(acc.type));

    if (targetAccounts.length === 0) {
      log.info('No accounts with renewal schedulers found, skipping');
      return;
    }

    let renewedCount = 0;
    let failedCount = 0;

    // 遍历每个有续期调度器的账号
    for (const account of targetAccounts) {
      try {
        const config = typeof account.config === 'string' ? JSON.parse(account.config) : account.config;

        // 获取该提供商类型的续期调度器
        const scheduler = renewalRegistry.getScheduler(account.type);

        if (!scheduler) {
          log.warn('No renewal scheduler registered for provider type', {
            accountId: account.id,
            accountName: account.name,
            type: account.type,
          });
          continue;
        }

        // 通过调度器获取可续期的域名列表
        const renewableDomains = await scheduler.listRenewableDomains(config);

        log.info('Fetched renewable domains via scheduler', {
          accountId: account.id,
          accountName: account.name,
          type: account.type,
          count: renewableDomains.length,
        });

        // 对每个需要续期的域名执行续期
        for (const domain of renewableDomains) {
          try {
            const providerDomainId = domain.id;
            if (!providerDomainId) {
              log.warn('Domain has no id, skipping', {
                domainName: domain.name || domain.full_domain,
              });
              continue;
            }

            // 从 renewable_domains 表查找该域名的本地记录
            // 先按 third_id 匹配（provider 侧的 ID），再按 full_domain 匹配
            let localDomains = await RenewableDomainOperations.getByAccountId(account.id);
            let localDomain = localDomains.find(
              (d: any) => String(d.third_id) === String(providerDomainId)
            );

            // 如果没找到，回退到按 full_domain 匹配
            if (!localDomain && domain.full_domain) {
              localDomain = localDomains.find(
                (d: any) => d.full_domain === domain.full_domain
              );
            }

            if (!localDomain) {
              log.warn('Domain not found in renewable_domains table, skipping', {
                providerDomainId,
                fullDomain: domain.full_domain,
                accountId: account.id,
              });
              continue;
            }

            // 检查续期是否已启用
            if (!localDomain.enabled) {
              log.info('Skipping disabled domain', {
                domainId: localDomain.id,
                domainName: localDomain.full_domain,
                enabled: localDomain.enabled,
              });
              continue;
            }

            log.info('Attempting domain renewal via scheduler', {
              domainName: domain.full_domain || domain.name,
              providerDomainId,
              localDomainId: localDomain.id,
            });

            const result = await scheduler.renewDomain(config, providerDomainId);

            if (result) {
              renewedCount++;
              log.info('Domain renewed successfully', {
                domainName: result.domain_name,
                previousExpiresAt: result.previous_expires_at,
                newExpiresAt: result.new_expires_at,
                remainingDays: result.remaining_days,
              });

              // 主核心事件主线：续期成功。事件需要 domains 表的主键，
              // renewable_domains 的 id 与 domains.id 不是同一实体，不能混用。
              const renewedName = String(result.domain_name ?? domain.full_domain ?? domain.name ?? '');
              if (renewedName) {
                const localRecord = (await DomainOperations.getByName(renewedName)) as unknown as
                  | { id: number; account_id?: number }
                  | undefined;
                if (localRecord) {
                  // 续期后重置 WHOIS 去重，否则新的到期日不会再触发 whois.expiring
                  whoisEventDedupe.reset(localRecord.id);
                  publishDomainEvent({
                    action: 'renewed',
                    domain: { id: localRecord.id, name: renewedName, accountId: localRecord.account_id },
                    actor: { source: 'system' },
                  });
                }
              }

              // 更新 renewable_domains 表中的 expires_at
              if (result.new_expires_at) {
                try {
                  await RenewableDomainOperations.updateExpiresAt(localDomain.id, result.new_expires_at);
                  log.debug('Updated expires_at in renewable_domains', {
                    localDomainId: localDomain.id,
                    newExpiresAt: result.new_expires_at,
                  });
                } catch (updateError) {
                  log.error('Failed to update expires_at in renewable_domains', {
                    localDomainId: localDomain.id,
                    error: updateError instanceof Error ? updateError.message : String(updateError),
                  });
                }
              }
            } else {
              failedCount++;
              log.error('Domain renewal failed', {
                domainName: domain.full_domain || domain.name,
                providerDomainId,
              });
            }
          } catch (error) {
            failedCount++;
            log.error('Domain renewal error', {
              domainName: domain.full_domain || domain.name,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } catch (error) {
        log.error('Failed to process account', {
          accountId: account.id,
          accountName: account.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    log.info('Automatic domain renewal completed', {
      renewedCount,
      failedCount,
      totalAccounts: targetAccounts.length,
    });
  } catch (error) {
    log.error('Automatic domain renewal failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 启动域名续期定时任务
 * 每天 UTC 0:00 执行
 */
export async function startDomainRenewalJob(): Promise<void> {
  // 计算到下一个 UTC 0:00 的时间
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setUTCHours(24, 0, 0, 0); // 明天 UTC 0:00

  const initialDelay = nextRun.getTime() - now.getTime();

  log.info('Starting domain renewal job', {
    nextRun: nextRun.toISOString(),
    initialDelayMs: initialDelay,
    initialDelayHours: Math.round(initialDelay / (1000 * 60 * 60) * 100) / 100,
  });

  // 首次执行（在下一个 UTC 0:00）
  setTimeout(() => {
    taskManager.submit(
      {
        id: 'domain-renewal-initial',
        name: 'Domain Renewal Initial',
        concurrency: 1,       // 串行执行，避免并发续期
        timeout: 300000,      // 5分钟超时
        retries: 1,           // 失败重试1次
        retryDelay: 60000,    // 重试间隔1分钟
      },
      executeDomainRenewal
    ).catch(err => log.error('Initial renewal error:', { error: err }));

    // 之后每 24 小时执行一次
    setInterval(() => {
      taskManager.submit(
        {
          id: `domain-renewal-${Date.now()}`,
          name: 'Domain Renewal Scheduled',
          concurrency: 1,       // 串行执行
          timeout: 300000,      // 5分钟超时
          retries: 1,           // 失败重试1次
          retryDelay: 60000,    // 重试间隔1分钟
        },
        executeDomainRenewal
      ).catch(err => log.error('Scheduled renewal error:', { error: err }));
    }, 24 * 60 * 60 * 1000);
  }, initialDelay);
}

/**
 * 停止域名续期定时任务
 */
export function stopDomainRenewalJob(): void {
  if (renewalInterval) {
    clearInterval(renewalInterval);
    renewalInterval = null;
    log.info('Domain renewal job stopped');
  }
}