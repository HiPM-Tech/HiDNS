/**
 * NS Monitor Job Service
 * NS 监测定时任务服务 - 新架构（用户级）
 */

import { NSMonitorOperations, DomainOperations, AuditOperations, UserOperations, formatDateForDB } from '../db/bal/business-adapter';
import { resolveNsRecords, getNsStatus, validateNsRecords } from '../lib/dns/ns-lookup';
import { sendNotification, sendEmailToUser } from './notification';
import { taskManager } from './taskManager';
import { createLogger } from '../lib/logger';
import { publishNsEvent } from '../lib/domain-event-bus';

const log = createLogger('Job').sub('NsMonitor');
let monitorInterval: NodeJS.Timeout | null = null;

// 告警抑制配置：同一问题在30分钟内只发送一次通知
const ALERT_SUPPRESS_MINUTES = 30;

/**
 * 检查是否需要抑制告警（避免重复发送）
 * @returns true 表示需要抑制（不发送），false 表示可以发送
 */
async function shouldSuppressAlert(monitorId: number, alertType: string, lastAlertAt: string | null): Promise<boolean> {
  try {
    if (!lastAlertAt) {
      return false; // 没有历史告警，不需要抑制
    }

    const lastAlertTime = new Date(lastAlertAt).getTime();
    const now = Date.now();
    const suppressTimeMs = ALERT_SUPPRESS_MINUTES * 60 * 1000;

    // 如果在抑制时间内，则抑制告警
    if (now - lastAlertTime < suppressTimeMs) {
      log.info('Alert suppressed (recent alert exists)', {
        monitorId,
        alertType,
        lastAlertAt,
        suppressMinutes: ALERT_SUPPRESS_MINUTES,
      });
      return true;
    }

    return false;
  } catch (error) {
    log.error('Failed to check alert suppression', { monitorId, alertType, error });
    return false; // 出错时不抑制，确保告警能被发送
  }
}

/**
 * 记录NS告警到审计日志
 */
async function logNsAlertToAudit(
  monitor: {
    id: number;
    domain_id: number;
    domain_name: string;
    user_id?: number;
  },
  status: 'mismatch' | 'missing' | 'poisoned',
  currentNs: string[],
  expectedNs: string[],
  isPoisoned?: boolean,
  encryptedNs?: string[],
  plainNs?: string[]
): Promise<void> {
  try {
    const alertTypeMap: Record<string, string> = {
      'mismatch': 'NS记录不匹配',
      'missing': 'NS记录缺失',
      'poisoned': 'DNS污染检测',
    };
    const alertTypeText = alertTypeMap[status] || 'NS异常';

    const detailsObj: Record<string, unknown> = {
      domain: monitor.domain_name,
      alertType: status,
      currentNs: currentNs.join(', ') || '无',
      expectedNs: expectedNs.join(', ') || '未配置',
      monitorId: monitor.id,
    };

    // 添加DNS污染检测详情
    if (isPoisoned) {
      detailsObj.isPoisoned = true;
      detailsObj.encryptedNs = encryptedNs?.join(', ') || '无';
      detailsObj.plainNs = plainNs?.join(', ') || '无';
    }

    const details = JSON.stringify(detailsObj);

    // 使用系统用户ID (0) 或者配置的创建者ID
    const userId = monitor.user_id || 0;

    await AuditOperations.log({
      user_id: userId,
      action: `ns_monitor_alert_${status}`,
      target_type: 'domain',
      target_id: monitor.domain_id.toString(),
      details: `${alertTypeText}: ${monitor.domain_name} - ${details}`,
    });

    log.info('NS alert logged to audit', {
      domain: monitor.domain_name,
      status,
      isPoisoned,
      userId,
    });
  } catch (error) {
    log.error('Failed to log NS alert to audit', { error });
  }
}

/**
 * 检查单个域名的 NS 记录
 */
async function checkDomainNs(
  publishedDomains: Set<string>,
  monitor: {
  id: number;
  domain_id: number;
  domain_name: string;
  expected_ns: string;
  user_id: number;
  status: string;
  alert_count: number;
  last_alert_at: string | null;
}): Promise<void> {
  try {
    log.info('Checking NS records', { domain: monitor.domain_name, monitorId: monitor.id });

    // 查询当前 NS 记录（带DNS污染检测）
    const nsResult = await resolveNsRecords(monitor.domain_name);
    const currentNs = nsResult.nsRecords;
    const currentNsStr = currentNs.join(', ');

    // 获取加密和明文查询结果
    const encryptedNs = nsResult.encryptedResult?.records?.map(r => r.data) || [];
    const plainNs = nsResult.plainResult?.records?.map(r => r.data) || [];

    // 解析预期的 NS 记录
    const expectedNs = (monitor.expected_ns as string) || '';
    const expectedList = expectedNs.split(',').map(s => s.trim()).filter(Boolean);

    // 确定状态
    let status: 'ok' | 'mismatch' | 'missing' | 'poisoned' = 'ok';
    if (currentNs.length === 0) {
      status = 'missing';
    } else if (nsResult.isPoisoned) {
      status = 'poisoned';
    } else if (expectedList.length > 0 && !validateNsRecords(currentNs, expectedList)) {
      status = 'mismatch';
    }

    // 获取当前时间（数据库兼容格式）
    const now = new Date();
    const nowStr = formatDateForDB(now);

    // 更新状态（包含加密和明文NS记录）
    await NSMonitorOperations.updateStatus(monitor.id, {
      current_ns: currentNsStr,
      encrypted_ns: encryptedNs.join(', '),
      plain_ns: plainNs.join(', '),
      is_poisoned: nsResult.isPoisoned,
      status,
      last_check_at: nowStr,
    });

    // 主核心事件主线：NS 状态变化（去重由总线按 status !== previousStatus 再判一次）
    if (monitor.status !== status && !publishedDomains.has(monitor.domain_name)) {
      publishedDomains.add(monitor.domain_name);
      // 注意：ns_monitor_domains 表**没有 domain_id 列**，Number(undefined) 会得到 NaN。
      // 这里显式给 0，并依赖 domain.name 定位；下游解析必须忽略非正数 id。
      publishNsEvent({
        domain: { id: 0, name: monitor.domain_name },
        status,
        previousStatus: (monitor.status ?? 'ok') as never,
      });
    }

    // 如果状态异常且与上次不同，发送告警
    if (status !== 'ok' && monitor.status !== status) {
      log.warn('NS record anomaly detected', {
        domain: monitor.domain_name,
        status,
        isPoisoned: nsResult.isPoisoned,
        current: currentNs,
        encrypted: encryptedNs,
        plain: plainNs,
        expected: expectedList,
      });

      // 记录告警到审计日志
      await logNsAlertToAudit(monitor, status, currentNs, expectedList, nsResult.isPoisoned, encryptedNs, plainNs);

      // 检查是否需要抑制告警
      const isSuppressed = await shouldSuppressAlert(monitor.id, status, monitor.last_alert_at);

      // 更新告警计数和时间
      const alertCount = monitor.alert_count || 0;
      await NSMonitorOperations.updateStatus(monitor.id, {
        alert_count: alertCount + 1,
        last_alert_at: nowStr,
      });

      // 发送通知（如果被抑制则不发送）
      if (!isSuppressed) {
        await sendNsAlert(monitor, status, currentNs, expectedList, nsResult.isPoisoned, encryptedNs, plainNs);
      }
    }

    log.info('NS check completed', {
      domain: monitor.domain_name,
      status,
      isPoisoned: nsResult.isPoisoned,
      currentNs: currentNsStr,
    });
  } catch (error) {
    log.error('Failed to check NS records', {
      domain: monitor.domain_name,
      error,
    });
  }
}

/**
 * 发送 NS 告警通知
 * 使用用户的通知偏好设置，邮件发送至用户自己的邮箱
 */
async function sendNsAlert(
  monitor: {
    id: number;
    domain_name: string;
    user_id: number;
  },
  status: 'mismatch' | 'missing' | 'poisoned',
  currentNs: string[],
  expectedNs: string[],
  isPoisoned?: boolean,
  encryptedNs?: string[],
  plainNs?: string[]
): Promise<void> {
  const alertTypeMap: Record<string, string> = {
    'mismatch': 'NS 记录不匹配',
    'missing': 'NS 记录缺失',
    'poisoned': 'DNS 污染检测',
  };
  const alertTypeText = alertTypeMap[status] || 'NS 异常';
  const title = `【HiDNS 告警】${monitor.domain_name} ${alertTypeText}`;

  let message = `域名: ${monitor.domain_name}\n` +
    `告警类型: ${alertTypeText}\n` +
    `当前 NS: ${currentNs.join(', ') || '无'}\n` +
    `预期 NS: ${expectedNs.join(', ') || '未配置'}\n`;

  // 添加DNS污染检测详情
  if (isPoisoned && encryptedNs && plainNs) {
    message += `加密 DNS 结果: ${encryptedNs.join(', ') || '无'}\n` +
      `明文 DNS 结果: ${plainNs.join(', ') || '无'}\n` +
      `⚠️ 警告: 加密DNS与明文DNS查询结果不一致，可能存在DNS污染!\n`;
  }

  message += `时间: ${new Date().toLocaleString('zh-CN')}`;

  try {
    // 获取用户的通知偏好设置
    const userId = monitor.user_id;
    let shouldSendEmail = false;
    let shouldSendChannels = false;

    if (userId) {
      const userPrefs = await NSMonitorOperations.getUserPrefs(userId);
      if (userPrefs) {
        shouldSendEmail = userPrefs.notify_email === 1 || userPrefs.notify_email === true;
        shouldSendChannels = userPrefs.notify_channels === 1 || userPrefs.notify_channels === true;
      } else {
        // 默认启用通知
        shouldSendEmail = true;
        shouldSendChannels = true;
      }
    } else {
      // 没有创建者信息，默认启用
      shouldSendEmail = true;
      shouldSendChannels = true;
    }

    // 使用纯文本格式，不使用HTML
    const plainMessage = message;

    // 发送邮件通知到用户自己的邮箱（如果启用）
    if (shouldSendEmail && userId) {
      try {
        const user = await UserOperations.getPublicById(userId);
        if (user && user.email) {
          const emailSent = await sendEmailToUser(user.email as string, title, plainMessage, plainMessage);
          if (emailSent) {
            log.info('Email notification sent to user', {
              domain: monitor.domain_name,
              userId,
              email: user.email,
              status,
              isPoisoned,
            });
          } else {
            log.warn('Failed to send email notification to user', {
              domain: monitor.domain_name,
              userId,
              email: user.email,
            });
          }
        } else {
          log.warn('User has no email configured, skipping email notification', {
            domain: monitor.domain_name,
            userId,
          });
        }
      } catch (emailError) {
        log.warn('Error sending email to user', {
          domain: monitor.domain_name,
          userId,
          error: emailError,
        });
      }
    }

    // 发送渠道通知（如果启用）
    if (shouldSendChannels) {
      try {
        await sendNotification(title, plainMessage, plainMessage);
        log.info('Channel notification sent', {
          domain: monitor.domain_name,
          status,
          isPoisoned,
          userId,
        });
      } catch (channelError) {
        log.warn('Error sending channel notification', {
          domain: monitor.domain_name,
          userId,
          error: channelError,
        });
      }
    }

    if (!shouldSendEmail && !shouldSendChannels) {
      log.info('Notification skipped (disabled in user preferences)', {
        domain: monitor.domain_name,
        userId,
      });
    }
  } catch (error) {
    log.error('Failed to send alert notification', {
      domain: monitor.domain_name,
      error,
    });
  }
}

/**
 * 执行 NS 监测任务
 */
async function runNsMonitorJob(): Promise<void> {
  try {
    log.info('Starting NS monitor job');

    // 获取所有启用的监测配置
    // 同一域名可能被多个用户监控：一次任务内只发布一条 ns.changed
    const publishedDomains = new Set<string>();
    const monitors = await NSMonitorOperations.getAllEnabled() as unknown as Array<{
      id: number;
      domain_id: number;
      domain_name: string;
      expected_ns: string;
      user_id: number;
      status: string;
      alert_count: number;
      last_alert_at: string | null;
    }>;

    if (monitors.length === 0) {
      log.info('No enabled NS monitor configurations');
      return;
    }

    log.info(`Checking ${monitors.length} domains`);

    // 使用任务管理器并发检查（最多同时5个）
    const tasks = monitors.map(monitor => {
      return taskManager.submit(
        {
          id: `ns-monitor-${monitor.id}`,
          name: `NS Monitor: ${monitor.domain_name}`,
          concurrency: 5, // 允许最多5个并发
          timeout: 30000, // 30秒超时
          retries: 2, // 失败重试2次
          retryDelay: 2000, // 重试间隔2秒
        },
        async () => {
          await checkDomainNs(publishedDomains, monitor);
        }
      );
    });

    // 等待所有任务完成
    await Promise.all(tasks);

    log.info('NS monitor job completed');
  } catch (error) {
    log.error('NS monitor job failed', { error });
  }
}

/**
 * 启动 NS 监测定时任务
 */
export function startNsMonitorJob(): void {
  if (monitorInterval) {
    log.warn('NS monitor job already started');
    return;
  }

  // 每 5 分钟检查一次
  monitorInterval = setInterval(runNsMonitorJob, 5 * 60 * 1000);

  log.info('NS monitor job started (interval: 5 minutes)');

  // 立即执行一次
  runNsMonitorJob();
}

/**
 * 停止 NS 监测定时任务
 */
export function stopNsMonitorJob(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    log.info('NS monitor job stopped');
  }
}

/**
 * 立即执行一次 NS 监测
 */
export async function runNsMonitorOnce(): Promise<void> {
  await runNsMonitorJob();
}
