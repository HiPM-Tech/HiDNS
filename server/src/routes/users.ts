import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { authMiddleware, adminOnly, noTokenAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { User } from '../types';
import { ROLE_ADMIN, ROLE_SUPER, ROLE_USER, normalizeRole } from '../utils/roles';
import { parseInteger, sendError, sendSuccess } from '../utils/http';
import { isValidUsername } from '../utils/validation';
import { UserOperations } from '../db/bal/business-adapter';
import { wsService } from '../service/websocket';
import { createLogger } from '../lib/logger';

const log = createLogger('HTTP').sub('Route').sub('Users');
const router = Router();

/**
 * 能收到用户管理事件的用户集合：admin 及以上、账号未停用。
 *
 * 为什么需要它：user_* 事件原本走 wsService.broadcast，payload 带用户名与角色，
 * 全局广播等于把「系统里有哪些账号、谁是管理员」推给所有在线客户端，
 * 而用户管理在 HTTP 上只有管理员可见。
 *
 * 口径直接复刻本文件读接口：GET /users 挂了 adminOnly（= isAdmin，role >= admin），
 * 因此收件人 = 全部 admin + 超管。
 *
 * 已知重复：domains.ts 里「可续期域名」的收件人也是同一套特权判定，两处都因为
 * realtime-audience 只导出了 getSuperAdminUserIds 而各自实现；后续应向该模块补一个
 * getAdminUserIds 后合并。
 */
async function getUserManagementAudienceUserIds(): Promise<number[]> {
  const audience = new Set<number>();
  try {
    const users = (await UserOperations.getAll()) as unknown as Array<{
      id?: number;
      role_level?: number;
      role?: number;
      status?: number;
    }>;
    for (const user of users) {
      const id = Number(user.id);
      if (!Number.isFinite(id) || id <= 0) continue;
      // 停用账号不参与推送，与登录态口径一致
      if (Number(user.status) !== 1) continue;
      const level = Number(user.role_level ?? user.role ?? 0);
      if (level >= ROLE_ADMIN) audience.add(id);
    }
  } catch (error) {
    // fail-closed：算不出收件人就不推，管理端有列表刷新兜底
    log.error('Failed to resolve user management audience', { error });
    return [];
  }
  return [...audience];
}

/**
 * 用户管理事件的定向推送。收件人为空时跳过并记 warn，不回退全局广播。
 */
async function pushUserEvent(message: { type: string; data: unknown }): Promise<void> {
  try {
    const audience = await getUserManagementAudienceUserIds();
    if (audience.length === 0) {
      log.warn('No audience for user event, skipped', { type: message.type });
      return;
    }
    wsService.broadcastToUsers(audience, message);
  } catch (error) {
    log.error('Failed to send user event', { type: message.type, error });
  }
}

/**
 * @swagger
 * /api/users:
 *   get:
 *     summary: List all users (admin only)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of users
 */
router.get('/', authMiddleware, noTokenAuth('user management'), adminOnly, asyncHandler(async (_req: Request, res: Response) => {
  const users = await UserOperations.getAll();
  sendSuccess(res, users);
}));

/**
 * @swagger
 * /api/users:
 *   post:
 *     summary: Create a new user (admin only)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username:
 *                 type: string
 *               nickname:
 *                 type: string
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *               role:
 *                 type: string
 *                 enum: [1, 2]
 *     responses:
 *       200:
 *         description: User created
 */
router.post('/', authMiddleware, noTokenAuth('user management'), adminOnly, asyncHandler(async (req: Request, res: Response) => {
  const { username, nickname, email = '', password, role = ROLE_USER } = req.body as {
    username: string; nickname?: string; email?: string; password: string; role?: number;
  };
  const normalizedUsername = (username ?? '').trim();
  if (!normalizedUsername || !password) {
    sendError(res, 'Username and password are required');
    return;
  }
  if (!isValidUsername(normalizedUsername)) {
    sendError(res, 'Username must use letters, numbers, "_" or "-"');
    return;
  }
  const resolvedNickname = (nickname ?? '').trim() || normalizedUsername;
  const hash = bcrypt.hashSync(password, 10);
  const callerRole = normalizeRole(req.user?.role);
  let roleLevel = normalizeRole(role);
  if (callerRole === ROLE_ADMIN) {
    roleLevel = ROLE_USER;
  }
  if (roleLevel === ROLE_SUPER) {
    sendError(res, 'Super admin cannot be created');
    return;
  }
  const roleText = roleLevel >= ROLE_ADMIN ? 'admin' : 'member';
  try {
    const id = await UserOperations.create({
      username: normalizedUsername,
      nickname: resolvedNickname,
      email,
      password_hash: hash,
      role: roleText,
      role_level: roleLevel,
    });

    // 推送 WebSocket 消息：只推给管理员（口径同 GET /users 的 adminOnly）
    await pushUserEvent({
      type: 'user_created',
      data: {
        userId: id,
        username: normalizedUsername,
        role: roleText,
      },
    });

    sendSuccess(res, { id });
  } catch {
    sendError(res, 'Username already exists');
  }
}));

/**
 * @swagger
 * /api/users/{id}:
 *   put:
 *     summary: Update a user (admin only)
 *     tags: [Users]
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
 *               nickname:
 *                 type: string
 *               email:
 *                 type: string
 *               role:
 *                 type: string
 *               status:
 *                 type: integer
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: User updated
 */
router.put('/:id', authMiddleware, noTokenAuth('user management'), adminOnly, asyncHandler(async (req: Request, res: Response) => {
  const id = parseInteger(req.params.id, { min: 1 }) ?? 0;
  const user = await UserOperations.getById(id) as User | undefined;
  if (!user) {
    sendError(res, 'User not found');
    return;
  }
  const { nickname, email, role, status, password } = req.body as {
    nickname?: string; email?: string; role?: number; status?: number; password?: string;
  };
  const callerRole = normalizeRole(req.user?.role);
  const targetRole = normalizeRole(user.role);

  // Super admin cannot be modified
  if (targetRole === ROLE_SUPER) {
    sendError(res, 'Super admin cannot be modified');
    return;
  }

  // Admin cannot modify users with same or higher role level (peer protection)
  // This prevents admins from modifying other admins or being modified by other admins
  if (callerRole === ROLE_ADMIN && targetRole >= ROLE_ADMIN) {
    sendError(res, 'Permission denied: Cannot modify users with same or higher role level');
    return;
  }

  // Admin cannot upgrade users to admin level
  if (callerRole === ROLE_ADMIN && role !== undefined) {
    const newRoleLevel = normalizeRole(role);
    if (newRoleLevel >= ROLE_ADMIN) {
      sendError(res, 'Permission denied: Cannot grant admin privileges');
      return;
    }
  }

  const updates: { nickname?: string; email?: string; role_level?: number; role?: string; status?: number; password_hash?: string } = {};

  if (nickname !== undefined) {
    updates.nickname = nickname.trim() || user.username;
  }
  if (email !== undefined) { updates.email = email; }
  if (role !== undefined) {
    let roleLevel = normalizeRole(role);
    // Only super admin can create other admins
    if (callerRole !== ROLE_SUPER && roleLevel >= ROLE_ADMIN) {
      roleLevel = ROLE_USER;
    }
    if (roleLevel === ROLE_SUPER) {
      sendError(res, 'Super admin cannot be created through this endpoint');
      return;
    }
    updates.role_level = roleLevel;
    updates.role = roleLevel >= ROLE_ADMIN ? 'admin' : 'member';
  }
  if (status !== undefined) { updates.status = status; }
  if (password) { updates.password_hash = bcrypt.hashSync(password, 10); }

  await UserOperations.update(id, updates);

  // 推送 WebSocket 消息：只推给管理员。收件人在 update 之后算，
  // 角色被提升为管理员的人当次就能收到后续用户变更。
  await pushUserEvent({
    type: 'user_updated',
    data: {
      userId: id,
      username: user.username,
    },
  });

  sendSuccess(res);
}));

/**
 * @swagger
 * /api/users/{id}:
 *   delete:
 *     summary: Delete a user (admin only)
 *     tags: [Users]
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
 *         description: User deleted
 */
router.delete('/:id', authMiddleware, noTokenAuth('user management'), adminOnly, asyncHandler(async (req: Request, res: Response) => {
  const id = parseInteger(req.params.id, { min: 1 }) ?? 0;
  if (id === req.user!.userId) {
    sendError(res, 'Cannot delete yourself');
    return;
  }
  const target = await UserOperations.getById(id) as User | undefined;
  if (!target) {
    sendError(res, 'User not found');
    return;
  }
  const callerRole = normalizeRole(req.user?.role);
  const targetRole = normalizeRole(target.role);

  // Super admin cannot be deleted
  if (targetRole === ROLE_SUPER) {
    sendError(res, 'Super admin cannot be deleted');
    return;
  }

  // Admin cannot delete users with same or higher role level (peer protection)
  if (callerRole === ROLE_ADMIN && targetRole >= ROLE_ADMIN) {
    sendError(res, 'Permission denied: Cannot delete users with same or higher role level');
    return;
  }

  await UserOperations.delete(id);

  // 推送 WebSocket 消息：只推给管理员（删掉的可能正是某个非管理员，
  // 其账号信息不该广播给所有在线客户端）
  await pushUserEvent({
    type: 'user_deleted',
    data: {
      userId: id,
      username: target.username,
    },
  });

  sendSuccess(res);
}));

export default router;
