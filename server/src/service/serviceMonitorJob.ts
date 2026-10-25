import { ServiceMonitorOperations, getDbType } from '../db/bal/business-adapter';
import { getAllEnabled, runCheckAndUpdate, ServiceMonitorMonitor } from './serviceMonitor';
import { taskManager } from './taskManager';
import { reconnectDatabase } from '../db/lifecycle';
import { createLogger } from '../lib/logger';
import { wsService } from './websocket';
import { getSuperAdminUserIds } from './realtime-audience';

const log = createLogger('Job').sub('ServiceMonitor');
export function startServiceMonitorJob() {
  // 每 5 分钟检查一次，任务管理器控制并发并尊重每个监控的 check_interval
  setInterval(async () => {
    try {
      const configs = await getAllEnabled();

      if (configs.length === 0) {
        return; // 没有启用的监控
      }

      // 使用任务管理器并发处理所有监控
      const tasks = configs.map((monitor) => {
        return taskManager.submit(
          {
            id: `servicemonitor-${monitor.id}`,
            name: `ServiceMonitor Check: ${monitor.name}`,
            concurrency: 5,       // 允许最多5个并发检查
            timeout: Math.max(monitor.checkTimeout * 1000, 30000), // 至少30秒超时
            retries: 1,           // 失败重试1次
            retryDelay: 2000,     // 重试间隔2秒
          },
          async () => {
            // 获取最新状态以检查是否到了执行时间
            const status = await ServiceMonitorOperations.getStatus(monitor.id) as any;

            // 检查是否到了执行时间
            if (status?.last_check_at) {
              const lastCheckTime = new Date(status.last_check_at).getTime();
              const nowTime = Date.now();
              if (nowTime - lastCheckTime < monitor.checkInterval * 1000) {
                return; // 还没到检查时间
              }
            }

            await runCheckAndUpdate(monitor);
            try {
              // 检查结果只属于「监控所有者 + 超管」：与 GET /api/servicemonitor/:id 的读权限一致
              // （routes/servicemonitor.ts 只放行 owner 与超管）。全局广播会把他人监控 id
              // 与所属用户 id 推给所有在线用户。
              const audience = [monitor.userId, ...(await getSuperAdminUserIds())];
              wsService.broadcastToUsers(audience, {
                type: 'servicemonitor_checked',
                data: { id: monitor.id, userId: monitor.userId },
              });
            } catch { }
          }
        );
      });

      // 等待所有任务完成
      await Promise.all(tasks);
    } catch (e) {
      // 检查是否是连接错误，尝试重连
      if (e instanceof Error && e.message.includes('Database connection not initialized')) {
        log.warn('Database connection lost, attempting to reconnect...');
        try {
          await reconnectDatabase();
          log.info('Database reconnected successfully');
        } catch (reconnectError) {
          log.error('Failed to reconnect to database', { error: reconnectError });
        }
      } else {
        log.error('Error', { error: e });
      }
    }
  },   5 * 60 * 1000); // check every 10 seconds, but inside we respect checkInterval
}