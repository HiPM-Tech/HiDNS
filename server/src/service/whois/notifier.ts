/**
 * WHOIS 过期通知器
 *
 * 负责检查域名到期时间并发送通知
 */

import { WhoisOperations } from '../../db/bal/business-adapter';
import { Domain } from '../../types';
import { sendNotification } from '../notification';
import { createLogger } from '../../lib/logger';
import { publishWhoisEvent } from '../../lib/domain-event-bus';
import { whoisEventDedupe } from '../../lib/whois-event-dedupe';

const log = createLogger('WhoisService').sub('Notifier');
/**
 * 检查并发送过期通知
 */
export async function checkAndSendNotification(domain: Domain, expiresAt: Date): Promise<void> {
  try {
    const nowTime = new Date();
    const daysLeft = Math.ceil((expiresAt.getTime() - nowTime.getTime()) / (1000 * 60 * 60 * 24));

    // 获取通知设置
    const enableNotifyRow = await WhoisOperations.getNotificationSetting() as any;
    const enableNotify = enableNotifyRow ? enableNotifyRow.value === '1' || enableNotifyRow.value === 'true' : false;

    const thresholdRow = await WhoisOperations.getExpiryDays() as any;
    const threshold = thresholdRow ? parseInt(thresholdRow.value) : 30;

    // 主核心事件主线：到期临近（独立于通知开关，工作流可自行决定如何处置）。
    // 去重：剩余天数变化才发布，避免每次 WHOIS 同步都重复触发工作流。
    const domainId = Number((domain as unknown as { id: number }).id);
    // 去重按「剩余天数变化」推进：新建 whois 工作流最多晚一个 WHOIS 周期才触发，
    // 这是可接受的取舍；此处不再用 hasDomainEventSubscribers() 做守卫 ——
    // 引擎启动即订阅，该谓词在生产恒为真，加上去只会制造「已经挡住」的错觉。
    if (daysLeft <= threshold && whoisEventDedupe.shouldEmit(domainId, daysLeft)) {
      publishWhoisEvent({
        domain: { id: domainId, name: String(domain.name) },
        expiresAt: expiresAt.toISOString(),
        daysLeft,
      });
    }

    if (enableNotify && (daysLeft === threshold || daysLeft === 7 || daysLeft === 1)) {
      try {
        await sendNotification(
          `[HiDNS] Domain Expiring Soon: ${domain.name}`,
          `Your domain ${domain.name} is expiring in ${daysLeft} days (on ${expiresAt.toLocaleDateString()}). Please renew it soon.`
        );
        log.info(`Sent expiry notification for ${domain.name} (${daysLeft} days left)`);
      } catch (err) {
        log.error(`Failed to send notification for ${domain.name}`);
      }
    }
  } catch (error) {
    log.error(`Error checking notification for ${domain.name}`);
  }
}
