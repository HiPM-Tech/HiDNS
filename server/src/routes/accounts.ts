import { Router, Request, Response } from 'express';
import { DnsAccountOperations, TeamOperations, SettingsOperations } from '../db/bal/business-adapter';
import { authMiddleware } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { createAdapter, getProvider, getProviders, isStubProvider } from '../lib/dns/DnsHelper';
import { DnsAccount } from '../types';
import { normalizeProviderType } from '../lib/dns/providerAlias';
import { isAdmin, isSuper, normalizeRole, ROLE_ADMIN } from '../utils/roles';
import { parseInteger, sendError, sendSuccess, sendServerError } from '../utils/http';
import { accountEventData } from '../utils/accountEvent';
import { wsService } from '../service/websocket';
import { logAuditOperation } from '../service/audit';
import { createLogger } from '../lib/logger';


const log = createLogger('HTTP').sub('Route').sub('Accounts');
const router = Router();

async function canReadAccount(account: DnsAccount, userId: number, role: number): Promise<boolean> {
  if (isSuper(role)) return true;
  if (account.created_by === userId) return true;
  if (account.team_id) {
    return await TeamOperations.isMember(account.team_id, userId);
  }
  return false;
}

function canManageAccount(account: DnsAccount, userId: number, role: number): boolean {
  if (isSuper(role)) return true;
  return role >= ROLE_ADMIN && account.created_by === userId;
}

/**
 * @swagger
 * /api/accounts/providers:
 *   get:
 *     summary: List available provider types with their config fields
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Provider list
 */
router.get('/providers', authMiddleware, (_req: Request, res: Response) => {
  sendSuccess(res, getProviders());
});

/**
 * @swagger
 * /api/accounts:
 *   get:
 *     summary: List DNS provider accounts
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of accounts
 */
router.get('/', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const role = req.user!.role;

  let accounts: DnsAccount[];

  if (isSuper(role)) {
    accounts = await DnsAccountOperations.getAll() as unknown as DnsAccount[];
  } else {
    const teams = await TeamOperations.getByUserId(userId);
    const teamIds = teams.map(r => r.id as number);
    accounts = await DnsAccountOperations.getAccessibleByUserId(userId, teamIds) as unknown as DnsAccount[];
  }

  // Apply capability filter if purpose query param is specified
  const purpose = req.query.purpose as string | undefined;
  if (purpose === 'dns' || purpose === 'renewal') {
    accounts = accounts.filter((a) => {
      const provider = getProvider(normalizeProviderType(a.type));
      if (!provider) return false;
      return purpose === 'dns' ? provider.capabilities.dns : provider.capabilities.renewal;
    });
  }

  // Apply keyword search
  const keyword = (req.query.keyword as string || '').trim().toLowerCase();
  if (keyword) {
    accounts = accounts.filter((a) =>
      a.name.toLowerCase().includes(keyword) ||
      a.remark?.toLowerCase().includes(keyword) ||
      a.type.toLowerCase().includes(keyword)
    );
  }

  // Apply provider type filter
  const typeFilter = req.query.type as string | undefined;
  if (typeFilter) {
    accounts = accounts.filter((a) => a.type === typeFilter);
  }

  // Apply enabled filter
  const enabledFilter = req.query.enabled as string | undefined;
  if (enabledFilter === 'enabled') {
    accounts = accounts.filter((a) => Boolean(a.enabled));
  } else if (enabledFilter === 'disabled') {
    accounts = accounts.filter((a) => !Boolean(a.enabled));
  }

  // Check if showDnsProviderSecrets is enabled
  let showSecrets = false;
  try {
    const securityConfigValue = await SettingsOperations.get('security_config');
    if (securityConfigValue) {
      const securityConfig = JSON.parse(securityConfigValue);
      showSecrets = !!securityConfig.showDnsProviderSecrets;
    }
  } catch {
    // Ignore errors, default to false
  }

  // Mask config secrets unless showDnsProviderSecrets is enabled
  const safe = accounts.map(a => {
    // MySQL JSON type returns object directly, SQLite/PostgreSQL returns string
    const cfg = typeof a.config === 'string' ? JSON.parse(a.config) as Record<string, string> : a.config as Record<string, string>;
    const masked: Record<string, string> = {};
    if (showSecrets) {
      // Return actual values
      for (const k of Object.keys(cfg)) masked[k] = cfg[k];
    } else {
      // Mask all values
      for (const k of Object.keys(cfg)) masked[k] = '***';
    }
    return { ...a, type: normalizeProviderType(a.type), config: masked, enabled: Boolean(a.enabled) };
  });

  // Pagination (only when page param is provided)
  const page = parseInt(req.query.page as string) || 0;
  const pageSize = Math.min(parseInt(req.query.pageSize as string) || 20, 100);
  if (page > 0) {
    const total = safe.length;
    const totalPages = Math.ceil(total / pageSize);
    const start = (page - 1) * pageSize;
    const list = safe.slice(start, start + pageSize);
    sendSuccess(res, { list, total, page, pageSize, totalPages });
  } else {
    sendSuccess(res, safe);
  }
}));

/**
 * @swagger
 * /api/accounts:
 *   post:
 *     summary: Add a DNS account (validates credentials)
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [type, name, config]
 *             properties:
 *               type:
 *                 type: string
 *               name:
 *                 type: string
 *               config:
 *                 type: object
 *               remark:
 *                 type: string
 *               team_id:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Account created
 */
router.post('/', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  if (!isAdmin(req.user?.role)) {
    sendError(res, 'Permission denied');
    return;
  }
  const { type, name, config, remark = '', team_id } = req.body as {
    type: string; name: string; config: Record<string, string>; remark?: string; team_id?: number;
  };
  const normalizedType = normalizeProviderType(type ?? '');
  if (!normalizedType || !name || !config) {
    sendError(res, 'type, name, and config are required');
    return;
  }
  if (!getProvider(normalizedType)) {
    sendError(res, `Unknown provider type: ${type}`);
    return;
  }
  if (isStubProvider(normalizedType)) {
    sendError(res, 'Provider is a stub and cannot be added');
    return;
  }

  // Check for duplicate account name under the same provider type
  const existingAccounts = await DnsAccountOperations.getAll() as any[];
  const duplicate = existingAccounts.find(
    (acc) => acc.type === normalizedType && acc.name.toLowerCase() === name.toLowerCase()
  );
  if (duplicate) {
    sendError(res, `Account name "${name}" already exists for provider ${normalizedType}`);
    return;
  }

  try {
    const dnsAdapter = createAdapter(normalizedType, config);
    const ok = await dnsAdapter.check();
    if (!ok) {
      sendError(res, `Credential check failed: ${dnsAdapter.getError()}`);
      return;
    }
  } catch (e) {
    sendError(res, `Provider error: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const id = await DnsAccountOperations.create({
    type: normalizedType,
    name,
    config: JSON.stringify(config),
    remark,
    created_by: req.user!.userId,
    team_id: team_id ?? null
  });

  // 获取完整的账户数据用于 WebSocket 推送
  const newAccount = await DnsAccountOperations.getById(id);

  // 增量更新缓存
  // 推送 WebSocket 消息
  try {
    wsService.broadcast({
      type: 'account_created',
      data: {
        accountId: id,
        account: accountEventData(newAccount),
      },
    });
  } catch (error) {
    log.error('Failed to broadcast account_created event', { error });
  }

  sendSuccess(res, { id });
}));

/**
 * @swagger
 * /api/accounts/{id}:
 *   get:
 *     summary: Get account info
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Account info
 */
router.get('/:id', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const id = parseInteger(req.params.id) ?? 0;
  const account = await DnsAccountOperations.getById(id) as DnsAccount | undefined;
  const userRole = normalizeRole(req.user?.role);
  if (!account || !(await canReadAccount(account, req.user!.userId, userRole))) {
    sendError(res, 'Account not found');
    return;
  }

  // Check if showDnsProviderSecrets is enabled
  let showSecrets = false;
  try {
    const securityConfigValue = await SettingsOperations.get('security_config');
    if (securityConfigValue) {
      const securityConfig = JSON.parse(securityConfigValue);
      showSecrets = !!securityConfig.showDnsProviderSecrets;
    }
  } catch {
    // Ignore errors, default to false
  }

  // MySQL JSON type returns object directly, SQLite/PostgreSQL returns string
  const cfg = typeof account.config === 'string' ? JSON.parse(account.config) as Record<string, string> : account.config as Record<string, string>;
  const masked: Record<string, string> = {};
  if (showSecrets) {
    // Return actual values only when showDnsProviderSecrets is enabled
    for (const k of Object.keys(cfg)) masked[k] = cfg[k];
  } else {
    // Mask all values
    for (const k of Object.keys(cfg)) masked[k] = '***';
  }
  sendSuccess(res, { ...account, type: normalizeProviderType(account.type), config: masked, enabled: Boolean(account.enabled) });
}));

/**
 * @swagger
 * /api/accounts/{id}:
 *   put:
 *     summary: Update account
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               config:
 *                 type: object
 *               remark:
 *                 type: string
 *               team_id:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Account updated
 */
router.put('/:id', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const id = parseInteger(req.params.id) ?? 0;
  const account = await DnsAccountOperations.getById(id) as DnsAccount | undefined;
  if (!account || !canManageAccount(account, req.user!.userId, normalizeRole(req.user?.role))) {
    sendError(res, 'Account not found');
    return;
  }
  const { type, name, config, remark, team_id } = req.body as {
    type?: string; name?: string; config?: Record<string, string>; remark?: string; team_id?: number | null;
  };
  const normalizedType = type !== undefined ? normalizeProviderType(type) : undefined;
  if (normalizedType !== undefined) {
    if (!getProvider(normalizedType)) {
      sendError(res, `Unknown provider type: ${type}`);
      return;
    }
    if (isStubProvider(normalizedType)) {
      sendError(res, 'Provider is a stub and cannot be used');
      return;
    }
  }
  if (config) {
    try {
      const dnsAdapter = createAdapter(normalizedType ?? normalizeProviderType(account.type), config);
      const ok = await dnsAdapter.check();
      if (!ok) {
        sendError(res, `Credential check failed: ${dnsAdapter.getError()}`);
        return;
      }
    } catch (e) {
      sendError(res, `Provider error: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
  }

  // Check for duplicate account name when updating name or type
  if (name !== undefined || normalizedType !== undefined) {
    const newName = name ?? account.name;
    const newType = normalizedType ?? account.type;
    const existingAccounts = await DnsAccountOperations.getAll() as any[];
    const duplicate = existingAccounts.find(
      (acc) =>
        acc.id !== id &&
        acc.type === newType &&
        acc.name.toLowerCase() === newName.toLowerCase()
    );
    if (duplicate) {
      sendError(res, `Account name "${newName}" already exists for provider ${newType}`);
      return;
    }
  }

  const updates: Record<string, unknown> = {};
  if (normalizedType !== undefined) updates.type = normalizedType;
  if (name !== undefined) updates.name = name;
  if (config !== undefined) updates.config = JSON.stringify(config);
  if (remark !== undefined) updates.remark = remark;
  if (team_id !== undefined) updates.team_id = team_id;

  if (Object.keys(updates).length === 0) {
    sendSuccess(res);
    return;
  }

  await DnsAccountOperations.update(id, updates);

  // 获取更新后的完整账户数据用于 WebSocket 推送
  const updatedAccount = await DnsAccountOperations.getById(id);

  // 推送 WebSocket 消息
  try {
    wsService.broadcast({
      type: 'account_updated',
      data: {
        accountId: id,
        account: accountEventData(updatedAccount),
      },
    });
  } catch (error) {
    log.error('Failed to broadcast account_updated event', { error });
  }

  sendSuccess(res);
}));

/**
 * @swagger
 * /api/accounts/{id}:
 *   delete:
 *     summary: Delete account
 *     tags: [Accounts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Account deleted
 */
router.delete('/:id', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const id = parseInteger(req.params.id) ?? 0;
  const account = await DnsAccountOperations.getById(id) as DnsAccount | undefined;
  if (!account || !canManageAccount(account, req.user!.userId, normalizeRole(req.user?.role))) {
    sendError(res, 'Account not found');
    return;
  }
  await DnsAccountOperations.delete(id);

  // 推送 WebSocket 消息
  try {
    wsService.broadcast({
      type: 'account_deleted',
      data: {
        accountId: id,
        name: account.name,
      },
    });
  } catch (error) {
    log.error('Failed to broadcast account_deleted event', { error });
  }

  sendSuccess(res);
}));

/**
 * Toggle DNS account enabled status
 */
router.patch('/:id/toggle-enabled', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const id = parseInteger(req.params.id) ?? 0;
  const account = await DnsAccountOperations.getById(id) as DnsAccount | undefined;
  if (!account || !canManageAccount(account, req.user!.userId, normalizeRole(req.user?.role))) {
    sendError(res, 'Account not found');
    return;
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    sendError(res, 'Enabled field is required and must be boolean');
    return;
  }

  log.info('Toggle account enabled status', {
    id,
    enabled,
    userId: req.user?.userId
  });

  try {
    await DnsAccountOperations.updateEnabled(id, enabled);

    // Log audit operation
    await logAuditOperation(
      req.user!.userId,
      enabled ? 'enable_dns_account' : 'disable_dns_account',
      account.name,
      { enabled, accountId: id },
      req
    );

    log.info('Successfully toggled account enabled status', {
      id,
      enabled,
      userId: req.user?.userId
    });

    // Broadcast account metadata only; provider config must stay private
    const updatedAccount = await DnsAccountOperations.getById(id);
    try {
      wsService.broadcast({
        type: 'account_updated',
        data: {
          accountId: id,
          account: updatedAccount ? { ...accountEventData(updatedAccount), enabled: Boolean(updatedAccount.enabled) } : null,
        },
      });
    } catch (error) {
      log.error('Failed to broadcast account_updated event', { error });
    }

    sendSuccess(res, { enabled });
  } catch (error) {
    log.error('Failed to toggle account enabled status', {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
    sendError(res, 'Failed to update enabled status');
  }
}));

export default router;
