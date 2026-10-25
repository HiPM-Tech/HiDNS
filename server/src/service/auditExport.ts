import { AuditExportOperations, getDbType } from '../db/bal/business-adapter';
import { getDisplayDomain } from '../utils/dns';

/**
 * 审计日志导出服务
 */

/**
 * 将日期格式化为数据库兼容的格式 (YYYY-MM-DD HH:mm:ss)
 */
function formatDateForDB(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export interface AuditLogEntry {
  id: number;
  userId: number;
  username: string;
  nickname: string;
  action: string;
  domain: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface AuditLogFilters {
  domain?: string;
  userId?: number;
  action?: string;
  startDate?: string;
  endDate?: string;
}

/**
 * 获取审计日志（支持筛选）
 */
export async function getAuditLogs(
  page: number = 1,
  pageSize: number = 50,
  filters?: AuditLogFilters
): Promise<{ total: number; logs: AuditLogEntry[] }> {
  const conditions: string[] = ['1=1'];
  const params: unknown[] = [];

  if (filters?.domain) {
    conditions.push('l.domain LIKE ?');
    params.push(`%${filters.domain}%`);
  }
  if (filters?.userId) {
    conditions.push('l.user_id = ?');
    params.push(filters.userId);
  }
  if (filters?.action) {
    conditions.push('l.action = ?');
    params.push(filters.action);
  }
  if (filters?.startDate) {
    conditions.push('l.created_at >= ?');
    params.push(filters.startDate);
  }
  if (filters?.endDate) {
    conditions.push('l.created_at <= ?');
    params.push(filters.endDate);
  }

  const where = conditions.join(' AND ');
  const pageNum = Math.max(1, Math.floor(Number(page) || 1));
  const pageSizeNum = Math.max(1, Math.floor(Number(pageSize) || 50));
  const offset = (pageNum - 1) * pageSizeNum;

  // 获取总数
  const total = await AuditExportOperations.getCount(where, params);

  // 获取日志
  const logs = await AuditExportOperations.getLogs(where, params, pageSizeNum, offset);

  return {
    total,
    logs: logs.map((log: any) => ({
      id: log.id,
      userId: log.user_id,
      username: log.username || 'Unknown',
      nickname: log.nickname || '',
      action: log.action,
      domain: log.domain ? getDisplayDomain(log.domain, true) : log.domain,
      data: typeof log.data === 'string' ? JSON.parse(log.data || '{}') : log.data || {},
      createdAt: log.created_at,
    })),
  };
}

/**
 * 导出审计日志为 CSV
 */
export async function exportAuditLogsAsCSV(
  filters?: AuditLogFilters
): Promise<string> {
  const { logs } = await getAuditLogs(1, 10000, filters);

  // CSV 头
  const headers = ['ID', 'User', 'Action', 'Domain', 'Data', 'Created At'];
  const rows = logs.map((log) => [
    log.id,
    `${log.nickname || log.username}`,
    log.action,
    log.domain,
    JSON.stringify(log.data),
    log.createdAt,
  ]);

  // 转换为 CSV
  const csv = [
    headers.map(escapeCSV).join(','),
    ...rows.map((row) => row.map(escapeCSV).join(',')),
  ].join('\n');

  return csv;
}

/**
 * 导出审计日志为 JSON
 */
export async function exportAuditLogsAsJSON(
  filters?: AuditLogFilters
): Promise<string> {
  const { logs, total } = await getAuditLogs(1, 10000, filters);

  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      total,
      filters,
      logs,
    },
    null,
    2
  );
}

/**
 * 检测异常操作
 */
export async function detectAnomalies(userId: number, timeWindowMinutes: number = 60): Promise<string[]> {
  const anomalies: string[] = [];
  const nowTime = new Date();
  const timeWindow = formatDateForDB(new Date(nowTime.getTime() - timeWindowMinutes * 60 * 1000));

  // 检查：短时间内大量删除记录
  const deleteCount = await AuditExportOperations.getDeleteCount(userId, timeWindow);

  if (deleteCount > 10) {
    anomalies.push(`Unusual number of delete operations: ${deleteCount} in ${timeWindowMinutes} minutes`);
  }

  // 检查：短时间内大量创建记录
  const createCount = await AuditExportOperations.getCreateCount(userId, timeWindow);

  if (createCount > 50) {
    anomalies.push(`Unusual number of create operations: ${createCount} in ${timeWindowMinutes} minutes`);
  }

  // 检查：多个不同域名的操作
  const domainCount = await AuditExportOperations.getDomainCount(userId, timeWindow);

  if (domainCount > 20) {
    anomalies.push(`Unusual number of different domains accessed: ${domainCount} in ${timeWindowMinutes} minutes`);
  }

  return anomalies;
}

/**
 * 获取用户操作统计
 */
export async function getUserActionStats(userId: number, days: number = 7): Promise<Record<string, number>> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const results = await AuditExportOperations.getUserActionStats(userId, formatDateForDB(startDate));

  const stats: Record<string, number> = {};
  for (const row of results) {
    stats[(row as any).action] = (row as any).count;
  }

  return stats;
}

/**
 * 获取操作时间分布
 */
export async function getActionTimeDistribution(userId: number, days: number = 7): Promise<Record<string, number>> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const dbType = getDbType();

  let results: any[];
  if (dbType === 'postgresql') {
    results = await AuditExportOperations.getTimeDistributionPostgreSQL(userId, formatDateForDB(startDate));
  } else {
    results = await AuditExportOperations.getTimeDistributionSQLite(userId, formatDateForDB(startDate));
  }

  const distribution: Record<string, number> = {};
  for (let i = 0; i < 24; i++) {
    distribution[`${i.toString().padStart(2, '0')}:00`] = 0;
  }

  for (const row of results) {
    const hour = (row as any).hour?.toString().padStart(2, '0') || '00';
    distribution[`${hour}:00`] = (row as any).count;
  }

  return distribution;
}

/**
 * 转义 CSV 字段
 */
export function escapeCSV(field: unknown): string {
  let str = String(field ?? '');
  // 公式注入：以 = + - @ 或制表符开头的**每一行**都会被表格软件当公式执行
  // （多行字段里换行后的内容在按行解析时同样是行首）。
  if (/^[=+\-@\t]/.test(str)) str = "'" + str;
  str = str.replace(/\n([=+\-@\t])/g, "\n'$1");
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
