/**
 * NS Monitor Routes
 * NS 监测路由 - 新架构（用户级）
 */

import { sendError, sendSuccess } from '../utils/http';
import { Router, Request, Response } from 'express';
import { NSMonitorOperations, DomainOperations, getDbType, formatDateForDB } from '../db/bal/business-adapter';
import { authMiddleware } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { createLogger } from '../lib/logger';
import { normalizeRole, isSuper, isAdmin } from '../utils/roles';
import { resolveNsRecords, NSLookupResult, validateNsRecords } from '../lib/dns/ns-lookup';
import { getDomainAccess } from './domains';
import { wsService } from '../service/websocket';
import { normalizeDomain, isValidDomain, toUnicode, getDisplayDomain } from '../utils/dns';

const log = createLogger('HTTP').sub('Route').sub('NsMonitor');
const router = Router();

/** 将布尔值转换为数据库特定的布尔类型 */
function toDbBoolean(value: boolean, dbType: string): boolean | number {
  return dbType === 'postgresql' ? value : value ? 1 : 0;
}

// ============================================================================
// 用户 NS 监测偏好设置
// ============================================================================

/**
 * @swagger
 * /api/ns-monitor/user/prefs:
 *   get:
 *     summary: Get user's NS monitor preferences
 *     tags: [NS Monitor]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User's NS monitor preferences
 */
router.get('/user/prefs', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;

  const prefs = await NSMonitorOperations.getUserPrefs(userId);

  sendSuccess(res, prefs || {
      user_id: userId,
      notify_email: true,
      notify_channels: true,
      check_interval: 3600,
    });
}));

/**
 * @swagger
 * /api/ns-monitor/resolve-ns:
 *   post:
 *     summary: Resolve NS records for a domain (encrypted DNS first, then fallback to plain)
 *     tags: [NS Monitor]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               domain:
 *                 type: string
 *                 description: Domain name to resolve
 *     responses:
 *       200:
 *         description: NS records with encrypted and plain results
 */
router.post('/resolve-ns', authMiddleware, asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { domain } = req.body;

  if (!domain || typeof domain !== 'string') {
    sendError(res, 'Domain is required', 400);
    return;
  }

  // 验证域名格式（支持 IDN）
  if (!isValidDomain(domain)) {
    sendError(res, 'Invalid domain format', 400);
    return;
  }

  try {
    // 使用加密优先策略解析NS记录
    const nsResult = await resolveNsRecords(domain);

    // 获取 Unicode 格式的域名用于显示
    const unicodeDomain = toUnicode(domain);

    sendSuccess(res, {
        domain: unicodeDomain,
        punycodeDomain: normalizeDomain(domain),
        nsRecords: nsResult.nsRecords,
        encryptedNs: nsResult.encryptedResult?.records?.map(r => r.data) || [],
        plainNs: nsResult.plainResult?.records?.map(r => r.data) || [],
        isPoisoned: nsResult.isPoisoned,
        // 推荐使用加密查询结果，如果失败则使用明文结果
        recommendedNs: nsResult.encryptedResult?.records?.map(r => r.data) || nsResult.plainResult?.records?.map(r => r.data) || [],
      });
  } catch (error) {
    log.error('Failed to resolve NS records', {
      domain,
      error: error instanceof Error ? error.message : String(error),
    });
    sendError(res, 'Failed to resolve NS records', 500);
  }
}));

/**
 * @swagger
 * /api/ns-monitor/user/prefs:
 *   put:
 *     summary: Update user's NS monitor preferences
 *     tags: [NS Monitor]
 *     security:
 *       - bearerAuth: []
 */
router.put('/user/prefs', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const role = normalizeRole(req.user!.role);
  const { notify_email, notify_channels, check_interval } = req.body;

  const updates: Record<string, unknown> = {};
  const dbType = getDbType();

  // check_interval 所有用户都可以修改
  if (check_interval !== undefined) {
    updates.check_interval = check_interval;
  }

  // notify_email 所有用户都可以修改（邮件发送至用户自己的邮箱）
  if (notify_email !== undefined) {
    updates.notify_email = toDbBoolean(notify_email, dbType);
  }

  // notify_channels 只有管理员可以修改
  if (isAdmin(role) || isSuper(role)) {
    if (notify_channels !== undefined) {
      updates.notify_channels = toDbBoolean(notify_channels, dbType);
    }
  } else if (notify_channels !== undefined) {
    log.warn('Non-admin user attempted to modify notification channels', {
      userId,
      role,
    });
  }

  if (Object.keys(updates).length === 0) {
    sendError(res, 'No valid fields to update', 400);
    return;
  }

  const existing = await NSMonitorOperations.getUserPrefs(userId);

  if (existing) {
    await NSMonitorOperations.updateUserPrefs(userId, updates);
  } else {
    await NSMonitorOperations.createUserPrefs(userId, {
      notify_email: toDbBoolean(true, dbType),
      notify_channels: toDbBoolean(true, dbType),
      check_interval: 3600,
      ...updates,
    });
  }

  log.info('User preferences updated', { userId, updates });

  // 推送 WebSocket 消息：偏好设置是「用户私有」数据
  // （读接口 GET /ns-monitor/user/prefs 只查自己的 user_id），因此只推给本人，
  // 多端登录时其余标签页仍能同步，别的用户不该收到。
  try {
    wsService.broadcastToUsers([userId], {
      type: 'ns_monitor_prefs_updated',
      data: {
        userId,
      },
    });
  } catch (error) {
    log.error('Failed to send ns_monitor_prefs_updated event', { error });
  }

  sendSuccess(res, null, 'Preferences updated successfully');
}));

// ============================================================================
// 域名监测列表
// ============================================================================

/**
 * @swagger
 * /api/ns-monitor:
 *   get:
 *     summary: List user's NS monitor configurations
 *     tags: [NS Monitor]
 *     security:
 *       - bearerAuth: []
 */
router.get('/', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
  const keyword = req.query.keyword as string | undefined;

  const { list, total } = await NSMonitorOperations.getUserMonitorsWithPagination(userId, page, pageSize, keyword);

  sendSuccess(res, { list, total, page, pageSize });
}));

/**
 * @swagger
 * /api/ns-monitor/available-domains:
 *   get:
 *     summary: Get available domains for NS monitor (Level 1 - ALL, no enabled filters)
 *     description: Returns all domains accessible to the user, regardless of account/domain enabled status. Used for NS monitor domain selection.
 *     tags: [NS Monitor]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of available domains
 */
router.get('/available-domains', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const role = normalizeRole(req.user!.role);
  const tokenPayload = (req as any).tokenPayload;

  // Level 1: Reuse DomainOperations.getAll() for super admin
  // For regular users, use dedicated function that filters by user's accounts
  let allDomains: any[];

  if (isSuper(role)) {
    // Super admin: reuse existing getAll() function
    allDomains = await DomainOperations.getAll() as any[];
  } else {
    // Regular user: use dedicated function (no enabled filter)
    allDomains = await DomainOperations.getAvailableDomainsForNSMonitor(userId, false) as any[];
  }

  // Filter out domains that already have NS monitor configured
  const monitoredDomainNames = new Set(
    (await NSMonitorOperations.getUserMonitors(userId)).map((m: any) => m.domain_name)
  );

  const availableDomains = allDomains.filter((domain: any) =>
    !monitoredDomainNames.has(domain.name)
  );

  // For Session auth, convert Punycode to Unicode; for Token auth, keep raw
  const displayDomains = availableDomains.map((d: any) => ({
    id: d.id,
    name: tokenPayload ? d.name : getDisplayDomain(d.name, true),
    account_id: d.account_id,
  }));

  sendSuccess(res, displayDomains);
}));

/**
 * @swagger
 * /api/ns-monitor/{id}:
 *   get:
 *     summary: Get NS monitor configuration by ID
 *     tags: [NS Monitor]
 *     security:
 *       - bearerAuth: []
 */
router.get('/:id', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.userId;

  const monitor = await NSMonitorOperations.getById(parseInt(id), userId);
  if (!monitor) {
    sendError(res, 'Configuration not found', 404);
    return;
  }

  sendSuccess(res, monitor);
}));

/**
 * @swagger
 * /api/ns-monitor:
 *   post:
 *     summary: Create NS monitor configuration
 *     tags: [NS Monitor]
 *     security:
 *       - bearerAuth: []
 */
router.post('/', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const { domain_name, expected_ns, enabled } = req.body;
  const userId = req.user!.userId;
  const role = normalizeRole(req.user!.role);

  if (!domain_name) {
    sendError(res, 'domain_name is required', 400);
    return;
  }

  // Normalize domain name to Punycode for database storage/query
  const normalizedDomainName = normalizeDomain(domain_name);

  // Verify domain exists in domains table
  const domain = await DomainOperations.getByName(normalizedDomainName);
  if (!domain || !domain.name) {
    sendError(res, 'Domain not found in domains table', 404);
    return;
  }
  const domainId = domain.id as number;
  const domainName = domain.name as string;

  // Check permission (optional, based on domain access)
  if (!isSuper(role)) {
    const access = await getDomainAccess(domainId, userId, role);
    if (!access.canWrite) {
      sendError(res, 'Access denied', 403);
      return;
    }
  }

  // Check if already exists for this domain name
  const existing = await NSMonitorOperations.getByDomainName(userId, domainName);
  if (existing) {
    // Delete old monitor config first
    log.info('Deleting old monitor config for same domain name', {
      oldMonitorId: existing.id,
      domainName,
    });
    await NSMonitorOperations.delete(existing.id as number, userId);
  }

  // Auto-fetch expected NS if not provided
  let finalExpectedNs = expected_ns || '';
  if (!finalExpectedNs) {
    try {
      const nsResult = await resolveNsRecords(domainName);
      if (nsResult.nsRecords.length > 0) {
        finalExpectedNs = nsResult.nsRecords.join(', ');
        log.info('Auto-filled expected NS', {
          domainName,
          nsRecords: nsResult.nsRecords,
        });
      }
    } catch (error) {
      log.warn('Failed to auto-fetch NS records', { domainName, error });
    }
  }

  const id = await NSMonitorOperations.create({
    user_id: userId,
    domain_name: domainName,
    expected_ns: finalExpectedNs,
  });

  log.info('Monitor created', { domainName, userId, monitorId: id });

  // 获取完整的监测配置数据用于 WebSocket 推送
  const newMonitor = await NSMonitorOperations.getById(id, userId);

  // 推送 WebSocket 消息：NS 监测配置按用户隔离（读接口 GET /:id 走
  // NSMonitorOperations.getById(id, userId)，非本人查不到），收件人只有创建者本人。
  try {
    wsService.broadcastToUsers([userId], {
      type: 'ns_monitor_created',
      data: {
        monitorId: id,
        domainName,
        userId,
        monitor: newMonitor,
      },
    });
  } catch (error) {
    log.error('Failed to send ns_monitor_created event', { error });
  }

  sendSuccess(res, { id });
}));

/**
 * @swagger
 * /api/ns-monitor/{id}:
 *   put:
 *     summary: Update NS monitor configuration
 *     tags: [NS Monitor]
 *     security:
 *       - bearerAuth: []
 */
router.put('/:id', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { expected_ns, enabled } = req.body;
  const userId = req.user!.userId;
  const dbType = getDbType();

  const monitor = await NSMonitorOperations.getById(parseInt(id), userId);
  if (!monitor) {
    sendError(res, 'Configuration not found', 404);
    return;
  }

  const updates: Record<string, unknown> = {};
  if (expected_ns !== undefined) updates.expected_ns = expected_ns;
  if (enabled !== undefined) updates.enabled = toDbBoolean(enabled, dbType);

  if (Object.keys(updates).length === 0) {
    sendError(res, 'No fields to update', 400);
    return;
  }

  await NSMonitorOperations.update(parseInt(id), userId, updates);

  log.info('Monitor updated', { monitorId: id, userId, updates });

  // 获取更新后的完整监测配置数据用于 WebSocket 推送
  const updatedMonitor = await NSMonitorOperations.getById(parseInt(id), userId);

  // 推送 WebSocket 消息：同上，监测配置只对本人可见，只推给配置所属用户。
  try {
    wsService.broadcastToUsers([userId], {
      type: 'ns_monitor_updated',
      data: {
        monitorId: parseInt(id),
        userId,
        monitor: updatedMonitor,
      },
    });
  } catch (error) {
    log.error('Failed to send ns_monitor_updated event', { error });
  }

  sendSuccess(res, null, 'success');
}));

/**
 * @swagger
 * /api/ns-monitor/{id}:
 *   delete:
 *     summary: Delete NS monitor configuration
 *     tags: [NS Monitor]
 *     security:
 *       - bearerAuth: []
 */
router.delete('/:id', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = req.user!.userId;

  const monitor = await NSMonitorOperations.getById(parseInt(id), userId);
  if (!monitor) {
    sendError(res, 'Configuration not found', 404);
    return;
  }

  await NSMonitorOperations.delete(parseInt(id), userId);

  log.info('Monitor deleted', { monitorId: id, userId });

  // 推送 WebSocket 消息：同上，只推给配置所属用户；全局广播会把
  // 「某用户正在监测哪些域名」暴露给所有在线客户端。
  try {
    wsService.broadcastToUsers([userId], {
      type: 'ns_monitor_deleted',
      data: {
        monitorId: parseInt(id),
        userId,
      },
    });
  } catch (error) {
    log.error('Failed to send ns_monitor_deleted event', { error });
  }

  sendSuccess(res, null, 'success');
}));

/** 执行 NS 检查并返回结果 */
async function performNsCheck(monitorId: number, monitor: any, userId: number): Promise<{
  success: boolean;
  statusCode?: number;
  result?: any;
}> {
  const domain = await DomainOperations.getByName(monitor.domain_name as string);
  if (!domain) {
    return { success: false, statusCode: 404, result: { success: false, error: 'Domain not found' } };
  }

  // Query current NS records with dual query (encrypted + plain)
  const nsResult: NSLookupResult = await resolveNsRecords(domain.name as string);
  const currentNs = nsResult.nsRecords;
  const currentNsStr = currentNs.join(', ');

  // Get encrypted and plain query results
  const encryptedNs = nsResult.encryptedResult?.records?.map(r => r.data) || [];
  const plainNs = nsResult.plainResult?.records?.map(r => r.data) || [];

  // Check against expected
  const expectedNs = (monitor.expected_ns as string) || '';
  let status: 'ok' | 'mismatch' | 'missing' | 'poisoned' = 'ok';

  if (currentNs.length === 0) {
    status = 'missing';
  } else if (nsResult.isPoisoned) {
    status = 'poisoned';
  } else if (expectedNs) {
    const expectedList = expectedNs.split(',').map(s => s.trim()).filter(Boolean);
    if (!validateNsRecords(currentNs, expectedList)) {
      status = 'mismatch';
    }
  }

  // Update status with encrypted and plain NS records
  await NSMonitorOperations.updateStatus(monitorId, {
    current_ns: currentNsStr,
    encrypted_ns: encryptedNs.join(', '),
    plain_ns: plainNs.join(', '),
    is_poisoned: nsResult.isPoisoned,
    status,
    last_check_at: formatDateForDB(new Date()),
  });

  log.info('Manual check completed', {
    monitorId,
    domainName: monitor.domain_name,
    status,
    isPoisoned: nsResult.isPoisoned,
    encryptedCount: encryptedNs.length,
    plainCount: plainNs.length,
  });

  return {
    success: true,
    result: {
      current_ns: currentNs,
      encrypted_ns: encryptedNs,
      plain_ns: plainNs,
      is_poisoned: nsResult.isPoisoned,
      expected_ns: expectedNs.split(',').map(s => s.trim()).filter(Boolean),
      status,
    },
  };
}

/**
 * @swagger
 * /api/ns-monitor/check:
 *   post:
 *     summary: Manually trigger NS check by domain name
 *     tags: [NS Monitor]
 *     security:
 *       - bearerAuth: []
 */
router.post('/check', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const { domain_name } = req.body;
  const userId = req.user!.userId;

  if (!domain_name) {
    sendError(res, 'domain_name is required', 400);
    return;
  }

  // Normalize domain name to Punycode for database query
  const normalizedDomainName = normalizeDomain(domain_name);

  const monitor = await NSMonitorOperations.getByDomainName(userId, normalizedDomainName);
  if (!monitor) {
    sendError(res, 'Configuration not found for this domain', 404);
    return;
  }

  const monitorId = monitor.id as number;
  const result = await performNsCheck(monitorId, monitor, userId);
  if (!result.success) {
    res.status(result.statusCode!).json(result.result);
    return;
  }

  sendSuccess(res, result.result);
}));

export default router;
