import { Router, Request, Response } from 'express';
import { getDomainAccess } from './domains';
import { authMiddleware } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { DomainOperations } from '../db/bal/business-adapter';
import { createLogger } from '../lib/logger';
import { normalizeRole, isSuper } from '../utils/roles';
import { parseInteger, sendError, sendSuccess } from '../utils/http';
import { wsService } from '../service/websocket';
import { getSuperAdminUserIds } from '../service/realtime-audience';
import {
  getMonitors,
  getMonitor,
  getMonitorsWithPagination,
  getMonitorsByParentId,
  createMonitor,
  updateMonitor,
  deleteMonitor,
  performCheck,
  runCheckAndUpdate,
} from '../service/serviceMonitor';

const log = createLogger('HTTP').sub('Route').sub('ServiceMonitor');
const router = Router();

// ============================================================================
// 工具函数
// ============================================================================


/**
 * 监控字段校验（C 端细节轮 P1：端口 70000、告警天数 -5/9999、userinfo 目标都能入库）。
 * 返回中文错误信息；通过返回 null。
 */
function validateMonitorInput(type: string, target: string, interval: unknown, config: unknown): string | null {
  const t = String(target).trim();
  if (!t) return '目标不能为空';
  if (t.includes('@')) return '目标不能包含 “@”（会被当作 userinfo 改写主机）';
  if (/\s/.test(t)) return '目标不能包含空格';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) && type !== 'endpoint') return '目标只填主机名或 IP，不要带协议';
  if (t.length > 253) return '目标过长';

  const intervalNum = Number(interval);
  if (interval !== undefined && (!Number.isInteger(intervalNum) || intervalNum < 30 || intervalNum > 86400)) {
    return '检测周期需为 30–86400 之间的整数秒';
  }

  if (config !== undefined && (config === null || typeof config !== 'object' || Array.isArray(config))) {
    return '监控配置必须是对象';
  }
  const cfg = (config ?? {}) as Record<string, unknown>;
  for (const numericKey of ['port', 'checkPort', 'warn_days_before', 'expectedStatus', 'ttl']) {
    const value = cfg[numericKey];
    if (value !== undefined && typeof value === 'boolean') return `${numericKey} 必须是数字`;
  }
  if (type === 'dns_failover') {
    if (typeof cfg.recordName !== 'string' || !cfg.recordName.trim()) return '故障转移必须填写记录名';
    if (!['A', 'AAAA', 'CNAME'].includes(String(cfg.recordType))) return '故障转移记录类型只能是 A/AAAA/CNAME';
    if (!Array.isArray(cfg.backupValues) || cfg.backupValues.length === 0) return '故障转移至少需要一个备用值';
    if (cfg.backupValues.some((item) => typeof item !== 'string' || !item.trim())) return '备用值不能为空';
  }
  const port = cfg.port;
  if (port !== undefined && (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535)) {
    return '端口需在 1–65535 之间';
  }
  const warn = cfg.warn_days_before;
  if (warn !== undefined && (!Number.isInteger(Number(warn)) || Number(warn) < 1 || Number(warn) > 365)) {
    return '到期前告警天数需在 1–365 之间';
  }
  const status = cfg.expectedStatus;
  if (status !== undefined && (!Number.isInteger(Number(status)) || Number(status) < 100 || Number(status) > 599)) {
    return '期望状态码需在 100–599 之间';
  }
  const path = cfg.path;
  if (path !== undefined && (typeof path !== 'string' || !path.startsWith('/'))) {
    return '路径必须以 / 开头';
  }
  const checkPort = cfg.checkPort;
  if (checkPort !== undefined && (!Number.isInteger(Number(checkPort)) || Number(checkPort) < 1 || Number(checkPort) > 65535)) {
    return '检查端口需在 1–65535 之间';
  }
  const checkPath = cfg.checkPath;
  if (checkPath !== undefined && (typeof checkPath !== 'string' || !checkPath.startsWith('/') || /[\\s@]/.test(checkPath))) {
    return '检查路径必须以 / 开头且不能含空格或 @';
  }
  const method = cfg.checkMethod;
  if (method !== undefined && !['tcp', 'http', 'ping'].includes(String(method))) {
    return '检查方式只能是 tcp / http / ping';
  }
  const expectedBody = cfg.expectedBody;
  if (expectedBody !== undefined && (typeof expectedBody !== 'string' || expectedBody.length > 200)) {
    return '期望响应体最多 200 个字符';
  }
  return null;
}

/** Convert internal camelCase monitor to API snake_case response */
function toApiMonitor(monitor: any): any {
  if (!monitor) return monitor;
  const result: any = {
    id: monitor.id,
    name: monitor.name,
    monitor_type: monitor.type,
    enabled: monitor.enabled === undefined ? true : Boolean(monitor.enabled),
    target: monitor.target,
    check_interval: monitor.checkInterval,
    notify_on_failure: monitor.notifyOnFailure,
    notify_on_recovery: monitor.notifyOnRecovery,
    domain_id: monitor.domainId,
    parent_id: monitor.parentId,
    config: monitor.config,
    status: monitor.status?.status || 'unknown',
    last_check_at: monitor.status?.lastCheckAt || null,
    response_time: monitor.status?.lastResponseTime || null,
    result_data: monitor.status?.resultData || null,
    created_at: monitor.createdAt,
    updated_at: monitor.updatedAt,
  };
  return result;
}

/**
 * 能读到该服务监控的用户集合：监控所有者本人 + 超管。
 *
 * 为什么需要它：servicemonitor_* 事件原本走 wsService.broadcast，payload 带监控名、
 * 类型与目标地址（含被监控的域名/URL），全局广播等于把「谁在监控什么」推给所有
 * 在线客户端。
 *
 * 口径直接复刻本文件 GET /servicemonitor/:id 的判定（见该处理器）：
 * monitor.userId === 请求者 || isSuper(role)。超管集合复用 realtime-audience，
 * 避免第二份特权判定。
 */
async function getMonitorAudienceUserIds(ownerUserId: number): Promise<number[]> {
  const audience = new Set<number>();
  const owner = Number(ownerUserId);
  if (Number.isFinite(owner) && owner > 0) audience.add(owner);
  for (const superId of await getSuperAdminUserIds()) audience.add(superId);
  return [...audience];
}

/**
 * 服务监控事件的定向推送。收件人为空时跳过并记 warn，不回退全局广播（fail-closed）。
 */
async function pushMonitorEvent(
  ownerUserId: number,
  message: { type: string; data: unknown },
): Promise<void> {
  try {
    const audience = await getMonitorAudienceUserIds(ownerUserId);
    if (audience.length === 0) {
      log.warn('No audience for service monitor event, skipped', {
        ownerUserId,
        type: message.type,
      });
      return;
    }
    wsService.broadcastToUsers(audience, message);
  } catch (e) {
    log.error('WS broadcast error', e);
  }
}

// ============================================================================
// 路由
// ============================================================================

/**
 * GET /api/servicemonitor/stats - 仪表盘统计
 */
router.get('/stats', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const monitors = await getMonitors(userId);

  const typeCount: Record<string, number> = {};
  const statusCount: Record<string, number> = { ok: 0, warning: 0, error: 0, unknown: 0 };
  let total = monitors.length;

  for (const m of monitors) {
    typeCount[m.type] = (typeCount[m.type] || 0) + 1;
    const s = m.status?.status || 'unknown';
    statusCount[s] = (statusCount[s] || 0) + 1;
  }

  sendSuccess(res, {
    total,
    byType: typeCount,
    byStatus: statusCount,
  });
}));

/**
 * GET /api/servicemonitor - 列出用户监控（分页，可按类型过滤）
 */
router.get('/', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const page = Math.max(1, parseInteger(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInteger(req.query.pageSize) || 20));
  const type = req.query.type as string | undefined;
  const keyword = (req.query.keyword as string | undefined)?.trim() || undefined;

  const { monitors, total } = await getMonitorsWithPagination(userId, page, pageSize, type, keyword);
  sendSuccess(res, { list: monitors.map(toApiMonitor), total, page, pageSize });
}));

/**
 * GET /api/servicemonitor/available-domains - 列出可用于 dns_failover 的域名
 */
router.get('/available-domains', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const role = normalizeRole(req.user!.role);
  const { DnsAccountOperations } = await import('../db/bal/business-adapter');
  const domains = await DomainOperations.getAllForSuperAdminWithPagination({
    keyword: '',
    domainStatus: 'all',
    page: 1,
    pageSize: 1000,
  });

  // 过滤用户有权限的域名，同时校验账号和域名状态
  const accessible: any[] = [];
  for (const d of (domains.list as any[])) {
    if (!isSuper(role) && d.created_by !== userId) continue;
    const account = await DnsAccountOperations.getById(d.account_id) as any;
    if (!account || account.enabled === 0 || account.enabled === false) continue;
    if ((d.enabled === 0 || d.enabled === false) && (d.status !== 'active')) continue;
    accessible.push({ id: d.id, name: d.name, account_type: account.type, account_name: account.name });
  }

  sendSuccess(res, accessible);
}));

/**
 * GET /api/servicemonitor/children/:parentId - 获取绑定到指定父级的监控 (failover → endpoint)
 */
router.get('/children/:parentId', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const parentId = parseInteger(req.params.parentId, { min: 1 }) ?? 0;
  const userId = req.user!.userId;
  const children = await getMonitorsByParentId(parentId);

  // Only return children belonging to the user
  const filtered = children.filter(c => c.userId === userId || isSuper(normalizeRole(req.user!.role)));
  sendSuccess(res, filtered.map(toApiMonitor));
}));

/**
 * POST /api/servicemonitor - 创建监控
 */
router.post('/', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const body = req.body;

  // Normalize field names (frontend sends snake_case, internal uses camelCase)
  const name = body.name;
  const type = body.type || body.monitor_type;
  const target = body.target;
  const domainId = body.domainId ?? body.domain_id;
  const parentId = body.parentId ?? body.parent_id;
  const config = body.config;
  // allowPrivate 会把监控变成内网探测能力：只允许管理员开启
  if (config && typeof config === 'object' && (config as { allowPrivate?: boolean }).allowPrivate === true
      && normalizeRole(req.user!.role) < 2) {
    sendError(res, 'Only administrators can allow private targets', 403);
    return;
  }

  const checkInterval = body.checkInterval ?? body.check_interval;
  const checkTimeout = body.checkTimeout ?? body.check_timeout;
  const enabled = body.enabled;
  const notifyOnFailure = body.notifyOnFailure ?? body.notify_on_failure;
  const notifyOnRecovery = body.notifyOnRecovery ?? body.notify_on_recovery;

  if (!name || !type || !target) {
    sendError(res, 'name, type and target are required', 400);
    return;
  }

  if (!['ssl_certificate', 'endpoint', 'dns_failover'].includes(type)) {
    sendError(res, 'Invalid type. Must be one of: ssl_certificate, endpoint, dns_failover', 400);
    return;
  }

  const inputError = validateMonitorInput(String(type), String(target), checkInterval, config);
  if (inputError) {
    sendError(res, inputError, 400);
    return;
  }

  if (type === 'dns_failover' && domainId) {
    const access = await getDomainAccess(domainId, userId, normalizeRole(req.user!.role));
    if (!access.canWrite) {
      sendError(res, 'No write permission for the specified domain', 403);
      return;
    }
  }

  const id = await createMonitor({
    userId,
    name,
    type,
    target,
    // 只有 dns_failover 需要域名绑定；其它类型落 domain_id 只会变成脏数据
    domainId: type === 'dns_failover' ? domainId : undefined,
    parentId,
    config: config || {},
    checkInterval,
    checkTimeout,
    enabled,
    notifyOnFailure,
    notifyOnRecovery,
  });

  log.info(`ServiceMonitor monitor created: ${id}`, { userId, name, type, target });

  // 只推给能读到该监控的用户（所有者 + 超管，口径同 GET /servicemonitor/:id）
  await pushMonitorEvent(userId, { type: 'servicemonitor_created', data: { id, name, type, target, userId } });

  sendSuccess(res, { id });
}));

/**
 * GET /api/servicemonitor/:id - 获取单个监控
 */
router.get('/:id', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const monitorId = parseInteger(req.params.id, { min: 1 }) ?? 0;
  const monitor = await getMonitor(monitorId);

  if (!monitor) {
    sendError(res, 'Monitor not found', 404);
    return;
  }

  if (monitor.userId !== req.user!.userId && !isSuper(normalizeRole(req.user!.role))) {
    sendError(res, 'No permission', 403);
    return;
  }

  sendSuccess(res, toApiMonitor(monitor));
}));

/**
 * PUT /api/servicemonitor/:id - 更新监控
 */
router.put('/:id', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const monitorId = parseInteger(req.params.id, { min: 1 }) ?? 0;
  const existing = await getMonitor(monitorId);

  if (!existing) {
    sendError(res, 'Monitor not found', 404);
    return;
  }

  if (existing.userId !== req.user!.userId && !isSuper(normalizeRole(req.user!.role))) {
    sendError(res, 'No permission', 403);
    return;
  }

  const body = req.body;
  const name = body.name;
  const type = body.type || body.monitor_type;
  const target = body.target;
  const domainId = body.domainId ?? body.domain_id;
  const parentId = body.parentId ?? body.parent_id;
  const config = body.config;
  // allowPrivate 会把监控变成内网探测能力：只允许管理员开启
  if (config && typeof config === 'object' && (config as { allowPrivate?: boolean }).allowPrivate === true
      && normalizeRole(req.user!.role) < 2) {
    sendError(res, 'Only administrators can allow private targets', 403);
    return;
  }

  const checkInterval = body.checkInterval ?? body.check_interval;
  const checkTimeout = body.checkTimeout ?? body.check_timeout;
  const enabled = body.enabled;
  const notifyOnFailure = body.notifyOnFailure ?? body.notify_on_failure;
  const notifyOnRecovery = body.notifyOnRecovery ?? body.notify_on_recovery;

  const effectiveType = String(type ?? existing.type);
  if (!['ssl_certificate', 'endpoint', 'dns_failover'].includes(effectiveType)) {
    sendError(res, 'Invalid type. Must be one of: ssl_certificate, endpoint, dns_failover', 400);
    return;
  }

  const updateError = validateMonitorInput(effectiveType, String(target ?? existing.target), checkInterval, config);
  if (updateError) {
    sendError(res, updateError, 400);
    return;
  }

  // 与 create 对齐：dns_failover 会绑定域名，改动时必须校验对该域名的写权限，
  // 否则任何用户都能把自有监控改成指向他人域名，巡检时用受害者的 DNS 账号写记录（跨租户写入）。
  const effectiveDomainId = domainId ?? existing.domainId;
  if (effectiveType === 'dns_failover') {
    if (!effectiveDomainId) {
      sendError(res, 'dns_failover 监控必须绑定域名', 400);
      return;
    }
    const access = await getDomainAccess(Number(effectiveDomainId), req.user!.userId, normalizeRole(req.user!.role));
    if (!access.canWrite) {
      sendError(res, 'No write permission for the specified domain', 403);
      return;
    }
  }

  await updateMonitor(monitorId, {
    // 落库用校验过的域名 id：body 传 null 时不能把已绑定域名解绑成「静默失效的 failover」
    name, type, target,
    domainId: effectiveType === 'dns_failover' ? Number(effectiveDomainId) : undefined,
    parentId,
    config, checkInterval, checkTimeout, enabled, notifyOnFailure, notifyOnRecovery,
  });

  log.info(`ServiceMonitor monitor updated: ${monitorId}`, { userId: req.user!.userId });

  // 按监控所有者收口：超管代改时所有者同样要收到，其他人不该收到
  await pushMonitorEvent(Number(existing.userId), { type: 'servicemonitor_updated', data: { id: monitorId, userId: req.user!.userId } });

  sendSuccess(res, { id: monitorId });
}));

/**
 * DELETE /api/servicemonitor/:id - 删除监控
 */
router.delete('/:id', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const monitorId = parseInteger(req.params.id, { min: 1 }) ?? 0;
  const existing = await getMonitor(monitorId);

  if (!existing) {
    sendError(res, 'Monitor not found', 404);
    return;
  }

  if (existing.userId !== req.user!.userId && !isSuper(normalizeRole(req.user!.role))) {
    sendError(res, 'No permission', 403);
    return;
  }

  await deleteMonitor(monitorId);

  log.info(`ServiceMonitor monitor deleted: ${monitorId}`, { userId: req.user!.userId });

  await pushMonitorEvent(Number(existing.userId), { type: 'servicemonitor_deleted', data: { id: monitorId, userId: req.user!.userId } });

  sendSuccess(res, { id: monitorId });
}));

/**
 * POST /api/servicemonitor/:id/check - 手动触发检查
 */
router.post('/:id/check', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const monitorId = parseInteger(req.params.id, { min: 1 }) ?? 0;
  const existing = await getMonitor(monitorId);

  if (!existing) {
    sendError(res, 'Monitor not found', 404);
    return;
  }

  if (existing.userId !== req.user!.userId && !isSuper(normalizeRole(req.user!.role))) {
    sendError(res, 'No permission', 403);
    return;
  }

  // 执行检查
  const { status, responseTime, error, resultData } = await performCheck(existing);

  // 更新状态
  await runCheckAndUpdate(existing);

  await pushMonitorEvent(Number(existing.userId), { type: 'servicemonitor_checked', data: { id: monitorId, status, userId: req.user!.userId } });

  sendSuccess(res, {
    monitorId,
    status,
    responseTime,
    error,
    resultData,
  });
}));

export default router;