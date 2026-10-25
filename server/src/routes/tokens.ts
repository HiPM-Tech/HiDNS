import { Router, Request, Response } from 'express';
import { authMiddleware, noTokenAuth } from '../middleware/auth';
import { createUserToken, getUserTokens, deleteUserToken, toggleTokenStatus, updateTokenPermissions } from '../service/token';
import { normalizeTokenDomains, resolveTokenPolicy } from '../service/token-policy';
import { DomainOperations, TeamOperations } from '../db/bal/business-adapter';
import { sendError } from '../utils/http';
import { logAuditOperation } from '../service/audit';
import { normalizeRole } from '../utils/roles';
import { wsService } from '../service/websocket';
import { createLogger } from '../lib/logger';

const log = createLogger('HTTP').sub('Route').sub('Tokens');
const router = Router();

/**
 * @swagger
 * /api/tokens:
 *   get:
 *     summary: Get all tokens for current user
 *     tags: [Tokens]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of user tokens
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: number
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: number
 *                       name:
 *                         type: string
 *                       allowed_domains:
 *                         type: array
 *                         items:
 *                           type: number
 *                       allowed_services:
 *                         type: array
 *                         items:
 *                           type: string
 *                       start_time:
 *                         type: string
 *                         nullable: true
 *                       end_time:
 *                         type: string
 *                         nullable: true
 *                       max_role:
 *                         type: number
 *                       is_active:
 *                         type: boolean
 *                       created_at:
 *                         type: string
 *                       last_used_at:
 *                         type: string
 *                         nullable: true
 *                 msg:
 *                   type: string
 */
router.get('/', authMiddleware, noTokenAuth('token management'), async (req: Request, res: Response) => {
  try {
    const tokens = await getUserTokens(req.user!.userId);
    res.json({ code: 0, data: tokens, msg: 'success' });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to get tokens' });
  }
});

/**
 * @swagger
 * /api/tokens:
 *   post:
 *     summary: Create a new API token
 *     tags: [Tokens]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - allowed_domains
 *             properties:
 *               name:
 *                 type: string
 *                 description: Token name
 *               allowed_domains:
 *                 type: array
 *                 items:
 *                   type: number
 *                 description: List of allowed domain IDs (empty array means all domains)
 *               start_time:
 *                 type: string
 *                 format: date-time
 *                 description: Token activation time (optional)
 *               end_time:
 *                 type: string
 *                 format: date-time
 *                 description: Token expiration time (optional, null means no expiry)
 *     responses:
 *       200:
 *         description: Token created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: number
 *                 data:
 *                   type: object
 *                   properties:
 *                     token:
 *                       type: string
 *                       description: The plain token (only shown once)
 *                     tokenData:
 *                       type: object
 *                 msg:
 *                   type: string
 *       400:
 *         description: Invalid request parameters
 */
router.post('/', authMiddleware, noTokenAuth('token management'), async (req: Request, res: Response) => {
  const { name, allowed_domains, allowed_services, start_time, end_time, max_role } = req.body as {
    name?: string;
    allowed_domains?: Array<number | string>;
    allowed_services?: string[];
    start_time?: string;
    end_time?: string;
    max_role?: number;
  };

  if (!name || !allowed_domains) {
    res.status(400).json({ code: 400, msg: 'Missing required fields' });
    return;
  }

  const userRole = normalizeRole(req.user!.role);
  const domainIds = normalizeTokenDomains(allowed_domains);
  if (domainIds.length === 0) {
    res.status(400).json({ code: 400, msg: 'allowed_domains must contain at least one valid domain id' });
    return;
  }

  // 归属校验：白名单里的域名必须是创建者能读到的，否则可以塞入别人的域名 id，
  // 再靠令牌读取跨租户域名信息（渗透测试 A-4）。口径与 GET /domains 的可见性一致。
  {
    const role = normalizeRole(req.user!.role);
    const isSuperRole = role >= 3;
    const teamIds = await TeamOperations.getTeamIdsByUserId(req.user!.userId);
    const accessible = await DomainOperations.getAccessibleDomains({
      userId: req.user!.userId,
      teamIds,
      isSuper: isSuperRole,
    });
    const accessibleIds = new Set(accessible.map((row) => Number((row as { id: unknown }).id)));
    const inaccessible = domainIds.filter((id) => !accessibleIds.has(id));
    if (inaccessible.length > 0) {
      sendError(res, 'No permission for domains: ' + inaccessible.join(', '), 403);
      return;
    }
  }

  // 服务权限与角色上限：创建时即可表达，且不得越过创建者自身权限。
  // 历史实现把 allowed_services 硬编码为 ['*']、max_role 取创建者角色，导致「创建时无法限制、更新时才能改」。
  const policy = resolveTokenPolicy({
    allowedServices: allowed_services,
    maxRole: max_role,
    userRole,
  });
  if (!policy.ok) {
    res.status(policy.status).json({ code: policy.status, msg: policy.message });
    return;
  }

  try {
    const result = await createUserToken(req.user!.userId, {
      name,
      allowed_domains: domainIds,
      allowed_services: policy.services,
      start_time,
      end_time,
      max_role: policy.maxRole,
    });

    // 令牌创建等于签发长期凭据：必须留审计（此前 0 条记录）
    await logAuditOperation(req.user!.userId, 'create_token', name, {
      tokenId: result.tokenData?.id,
      domains: domainIds.length,
      services: policy.services,
      maxRole: policy.maxRole,
    }, req);

    res.json({
      code: 0,
      data: {
        token: result.token,
        tokenData: result.tokenData,
      },
      msg: 'Token created successfully',
    });

    // 推送 WebSocket 消息给当前用户
    try {
      wsService.sendToClient(req.user!.userId, {
        type: 'token_created',
        data: {
          tokenId: result.tokenData.id,
          name,
        },
      });
    } catch (error) {
      log.error('Failed to send token_created event', { error });
    }
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to create token' });
  }
});

/**
 * @swagger
 * /api/tokens/{id}:
 *   delete:
 *     summary: Delete a token
 *     tags: [Tokens]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: number
 *         description: Token ID
 *     responses:
 *       200:
 *         description: Token deleted successfully
 *       400:
 *         description: Invalid token ID
 *       500:
 *         description: Server error
 */
router.delete('/:id', authMiddleware, noTokenAuth('token management'), async (req: Request, res: Response) => {
  const tokenId = parseInt(req.params.id);
  if (isNaN(tokenId)) {
    res.status(400).json({ code: 400, msg: 'Invalid token ID' });
    return;
  }

  try {
    await deleteUserToken(tokenId, req.user!.userId);
    await logAuditOperation(req.user!.userId, 'delete_token', String(tokenId), {}, req);
    res.json({ code: 0, msg: 'Token deleted successfully' });

    // 推送 WebSocket 消息给当前用户
    try {
      wsService.sendToClient(req.user!.userId, {
        type: 'token_revoked',
        data: {
          tokenId,
        },
      });
    } catch (error) {
      log.error('Failed to send token_revoked event', { error });
    }
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to delete token' });
  }
});

/**
 * @swagger
 * /api/tokens/{id}/status:
 *   patch:
 *     summary: Toggle token active status
 *     tags: [Tokens]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: number
 *         description: Token ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - is_active
 *             properties:
 *               is_active:
 *                 type: boolean
 *                 description: New active status
 *     responses:
 *       200:
 *         description: Token status updated
 *       400:
 *         description: Invalid parameters
 *       500:
 *         description: Server error
 */
router.patch('/:id/status', authMiddleware, noTokenAuth('token management'), async (req: Request, res: Response) => {
  const tokenId = parseInt(req.params.id);
  const { is_active } = req.body;

  if (isNaN(tokenId) || typeof is_active !== 'boolean') {
    res.status(400).json({ code: 400, msg: 'Invalid parameters' });
    return;
  }

  try {
    await toggleTokenStatus(tokenId, req.user!.userId, is_active);
    await logAuditOperation(req.user!.userId, 'toggle_token', String(tokenId), { is_active }, req);
    res.json({ code: 0, msg: 'Token status updated' });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to update token status' });
  }
});

/**
 * @swagger
 * /api/tokens/{id}:
 *   put:
 *     summary: Update token permissions
 *     tags: [Tokens]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: number
 *         description: Token ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: Token name
 *               allowed_domains:
 *                 type: array
 *                 items:
 *                   type: number
 *                 description: List of allowed domain IDs (empty array means all domains)
 *               allowed_services:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: List of allowed services
 *               start_time:
 *                 type: string
 *                 format: date-time
 *                 description: Token activation time (optional)
 *               end_time:
 *                 type: string
 *                 format: date-time
 *                 description: Token expiration time (optional, null means no expiry)
 *     responses:
 *       200:
 *         description: Token permissions updated successfully
 *       400:
 *         description: Invalid parameters
 *       500:
 *         description: Server error
 */
router.put('/:id', authMiddleware, noTokenAuth('token management'), async (req: Request, res: Response) => {
  const tokenId = parseInt(req.params.id);
  const { name, allowed_domains, allowed_services, start_time, end_time } = req.body;

  if (isNaN(tokenId)) {
    res.status(400).json({ code: 400, msg: 'Invalid token ID' });
    return;
  }

  try {
    await updateTokenPermissions(tokenId, req.user!.userId, {
      name,
      allowed_domains,
      allowed_services,
      start_time,
      end_time,
    });

    // 推送 WebSocket 消息给当前用户
    try {
      wsService.sendToClient(req.user!.userId, {
        type: 'token_updated',
        data: {
          tokenId,
          name,
        },
      });
    } catch (error) {
      log.error('Failed to send token_updated event', { error });
    }

    res.json({ code: 0, msg: 'Token permissions updated successfully' });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to update token permissions' });
  }
});

/**
 * @swagger
 * /api/tokens/domains:
 *   get:
 *     summary: Get user's accessible domains for token creation
 *     tags: [Tokens]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of accessible domains
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: number
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: number
 *                       name:
 *                         type: string
 *                       account_name:
 *                         type: string
 *                 msg:
 *                   type: string
 *       500:
 *         description: Database connection not available
 */
router.get('/domains', authMiddleware, noTokenAuth('token management'), async (req: Request, res: Response) => {
  try {
    const domains = await DomainOperations.getUserAccessibleDomains(req.user!.userId);

    res.json({ code: 0, data: domains, msg: 'success' });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to get domains' });
  }
});

export default router;
