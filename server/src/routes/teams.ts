import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { Team, TeamMember } from '../types';
import { ROLE_ADMIN, isAdmin, isSuper } from '../utils/roles';
import { logAuditOperation } from '../service/audit';
import { sendError, sendSuccess } from '../utils/http';
import { createLogger } from '../lib/logger';
import { TeamOperations, DomainPermissionOperations, UserOperations, DomainOperations, DnsAccountOperations } from '../db/bal/business-adapter';
import { invalidateAccessCache } from '../workflow/access';
import { wsService } from '../service/websocket';
import { getSuperAdminUserIds } from '../service/realtime-audience';
import { getDisplayDomain } from '../utils/dns';

const log = createLogger('HTTP').sub('Route').sub('Teams');
const router = Router();

/**
 * 能读到该团队的用户集合：团队成员 + 超管。
 *
 * 为什么需要它：team_* 事件原本走 wsService.broadcast，payload 带团队名与成员 ID，
 * 全局广播等于把「谁和谁在同一个团队、团队有哪些成员」推给所有在线客户端，
 * 而 HTTP 上团队是受限资源。
 *
 * 口径直接复刻本文件读接口的判定：
 *   GET /teams            → super 看全部，其他人 getByUserId（自己所在的团队）
 *   GET /teams/:id        → isSuper(role) || isMember(teamId, userId)
 *   GET /teams/:id/members→ 同上
 * 因此收件人 = getMembers(teamId) 的 user_id 集合 ∪ 超管集合。
 * 超管集合复用 realtime-audience，避免第二份特权判定。
 */
async function getTeamAudienceUserIds(teamId: number): Promise<number[]> {
  const audience = new Set<number>();
  const add = (value: unknown): void => {
    const id = Number(value);
    if (Number.isFinite(id) && id > 0) audience.add(id);
  };

  try {
    const members = (await TeamOperations.getMembers(teamId)) as unknown as Array<{ user_id?: number }>;
    for (const member of members) add(member.user_id);
  } catch (error) {
    // 查不到成员时仍保留超管收件人，成员可由列表刷新兜底
    log.error('Failed to load team members for realtime audience', { teamId, error });
  }

  for (const superId of await getSuperAdminUserIds()) add(superId);
  return [...audience];
}

/**
 * 团队事件的定向推送。收件人为空时跳过并记 warn，不回退全局广播（fail-closed）。
 */
async function pushTeamEvent(
  teamId: number,
  audience: number[] | null,
  message: { type: string; data: unknown },
): Promise<void> {
  try {
    const targets = audience ?? (await getTeamAudienceUserIds(teamId));
    if (targets.length === 0) {
      log.warn('No audience for team event, skipped', { teamId, type: message.type });
      return;
    }
    wsService.broadcastToUsers(targets, message);
  } catch (error) {
    log.error('Failed to send team event', { teamId, type: message.type, error });
  }
}

/**
 * 域名归属校验：非超管必须是自己账号下的域名。
 * 所有「授予/修改/删除域名权限」的入口都必须调用，否则任意登录用户可对他人域名提权。
 */
async function requireDomainOwnership(
  domainId: number,
  userId: number,
  role: number,
): Promise<'ok' | 'not_found' | 'denied'> {
  if (isSuper(role)) return 'ok';
  const domain = (await DomainOperations.getById(domainId)) as unknown as
    | { id: number; account_id: number }
    | undefined;
  if (!domain) return 'not_found';
  const createdBy = await DnsAccountOperations.getCreatedBy(domain.account_id);
  return createdBy === userId ? 'ok' : 'denied';
}

/**
 * @swagger
 * /api/teams:
 *   get:
 *     summary: Get teams list
 *     tags: [Teams]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of teams
 */
router.get('/', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const role = req.user!.role;

  let teams: Team[];
  if (isSuper(role)) {
    teams = await TeamOperations.getAll() as unknown as Team[];
  } else {
    teams = await TeamOperations.getByUserId(userId) as unknown as Team[];
  }

  // Get member count and my_role for each team
  const teamsWithDetails = await Promise.all(
    teams.map(async (team) => {
      const members = await TeamOperations.getMembers(team.id) as unknown as TeamMember[];
      // Get user's role in this team
      let myRole: string | undefined;
      if (isSuper(role)) {
        myRole = 'super';
      } else {
        const member = await TeamOperations.getMemberWithRole(team.id, userId);
        myRole = member?.role;
      }
      return { ...team, member_count: members.length, my_role: myRole };
    })
  );

  sendSuccess(res, teamsWithDetails);
}));

/**
 * @swagger
 * /api/teams:
 *   post:
 *     summary: Create a new team
 *     tags: [Teams]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       200:
 *         description: Team created
 */
router.post('/', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const { name, description } = req.body as { name: string; description?: string };
  const userId = req.user!.userId;

  if (!name || name.trim().length === 0) {
    sendError(res, '请填写团队名称');
    return;
  }
  if (name.trim().length > 50) {
    sendError(res, '团队名称最多 50 个字符');
    return;
  }

  const id = await TeamOperations.create({
    name: name.trim(),
    description: description?.trim() || '',
    created_by: userId,
  });

  // Add creator as admin。两步不在同一事务里（BAL 操作各自拿连接），
  // 因此失败时做补偿删除，避免留下「没有任何成员的孤儿团队」。
  try {
    await TeamOperations.addMember(id, userId, 'admin');
  } catch (error) {
    log.error('Failed to add creator as team admin, rolling back team', { teamId: id, error });
    try { await TeamOperations.delete(id); } catch (rollbackError) {
      log.error('Rollback of team creation failed; orphan team left behind', { teamId: id, rollbackError });
    }
    sendError(res, 'Failed to create team', 500);
    return;
  }

  await logAuditOperation(userId, 'create_team', name.trim(), { teamId: id }, req as any);

  // 推送 WebSocket 消息：只推给能读到该团队的用户（创建者已是成员 + 超管，
  // 口径同 GET /teams/:id 的 isSuper || isMember）
  await pushTeamEvent(id, null, {
    type: 'team_created',
    data: {
      teamId: id,
      name: name.trim(),
    },
  });

  sendSuccess(res, { id }, 'Team created successfully');
}));

/**
 * @swagger
 * /api/teams/{id}:
 *   get:
 *     summary: Get team details
 *     tags: [Teams]
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
 *         description: Team details
 */
router.get('/:id', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const teamId = parseInt(req.params.id);
  const userId = req.user!.userId;
  const role = req.user!.role;

  const team = await TeamOperations.getById(teamId) as Team | undefined;
  if (!team) {
    sendError(res, 'Team not found', 404);
    return;
  }

  // Check if user is member
  const isMember = await TeamOperations.isMember(teamId, userId);
  if (!isSuper(role) && !isMember) {
    sendError(res, 'Access denied', 403);
    return;
  }

  const members = await TeamOperations.getMembers(teamId) as unknown as TeamMember[];

  sendSuccess(res, { ...team, members });
}));

/**
 * @swagger
 * /api/teams/{id}:
 *   put:
 *     summary: Update team
 *     tags: [Teams]
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
 *               description:
 *                 type: string
 *     responses:
 *       200:
 *         description: Team updated
 */
router.put('/:id', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const teamId = parseInt(req.params.id);
  const { name, description } = req.body as { name?: string; description?: string };
  const userId = req.user!.userId;
  const role = req.user!.role;

  const team = await TeamOperations.getById(teamId) as Team | undefined;
  if (!team) {
    sendError(res, 'Team not found', 404);
    return;
  }

  // Check permission (admin or creator)
  const member = await TeamOperations.getMemberWithRole(teamId, userId);
  if (!isSuper(role) && team.created_by !== userId && member?.role !== 'admin') {
    sendError(res, 'Permission denied', 403);
    return;
  }

  const updates: { name?: string; description?: string } = {};
  if (name !== undefined) {
    if (!name.trim() || name.trim().length > 50) {
      sendError(res, '团队名称需为 1–50 个字符');
      return;
    }
    updates.name = name.trim();
  }
  if (description !== undefined) updates.description = description.trim();

  await TeamOperations.update(teamId, updates);

  await logAuditOperation(userId, 'update_team', team.name, { teamId, ...updates }, req as any);

  // 推送 WebSocket 消息：只推给团队成员与超管
  await pushTeamEvent(teamId, null, {
    type: 'team_updated',
    data: {
      teamId,
      name: name ?? team.name,
    },
  });

  sendSuccess(res);
}));

/**
 * @swagger
 * /api/teams/{id}:
 *   delete:
 *     summary: Delete team
 *     tags: [Teams]
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
 *         description: Team deleted
 */
router.delete('/:id', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const teamId = parseInt(req.params.id);
  const userId = req.user!.userId;
  const role = req.user!.role;

  const team = await TeamOperations.getById(teamId) as Team | undefined;
  if (!team) {
    sendError(res, 'Team not found', 404);
    return;
  }

  // Only super admin or creator can delete
  if (!isSuper(role) && team.created_by !== userId) {
    sendError(res, 'Permission denied', 403);
    return;
  }

  // 收件人先算再删：团队行删除后 getMembers 查不到成员，只能剩下超管
  const deletedTeamAudience = await getTeamAudienceUserIds(teamId);
  await TeamOperations.delete(teamId);

  await logAuditOperation(userId, 'delete_team', team.name, { teamId }, req as any);

  // 推送 WebSocket 消息：只推给删除前能读到该团队的用户
  await pushTeamEvent(teamId, deletedTeamAudience, {
    type: 'team_deleted',
    data: {
      teamId,
      name: team.name,
    },
  });

  sendSuccess(res);
}));

/**
 * @swagger
 * /api/teams/{id}/members:
 *   get:
 *     summary: Get team members
 *     tags: [Teams]
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
 *         description: List of members
 */
router.get('/:id/members', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const teamId = parseInt(req.params.id);
  const userId = req.user!.userId;
  const role = req.user!.role;

  const team = await TeamOperations.getById(teamId) as Team | undefined;
  if (!team) {
    sendError(res, 'Team not found', 404);
    return;
  }

  // Check if user is member
  const isMember = await TeamOperations.isMember(teamId, userId);
  if (!isSuper(role) && !isMember) {
    sendError(res, 'Access denied', 403);
    return;
  }

  const members = await TeamOperations.getMembers(teamId) as unknown as TeamMember[];
  sendSuccess(res, members);
}));

/**
 * @swagger
 * /api/teams/{id}/members:
 *   post:
 *     summary: Add member to team
 *     tags: [Teams]
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
 *             required: [user_id, role]
 *             properties:
 *               user_id:
 *                 type: integer
 *               role:
 *                 type: string
 *                 enum: [admin, member]
 *     responses:
 *       200:
 *         description: Member added
 */
router.post('/:id/members', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const teamId = parseInt(req.params.id);
  const { user_id, userId: bodyUserId, role: memberRole } = req.body as { user_id?: number; userId?: number; role: 'admin' | 'member' };
  const targetUserId = user_id || bodyUserId;
  const userId = req.user!.userId;
  const role = req.user!.role;

  if (!targetUserId) {
    sendError(res, 'User ID is required');
    return;
  }

  const team = await TeamOperations.getById(teamId) as Team | undefined;
  if (!team) {
    sendError(res, 'Team not found', 404);
    return;
  }

  // Check permission (admin or creator)
  const member = await TeamOperations.getMemberWithRole(teamId, userId);
  if (!isSuper(role) && team.created_by !== userId && member?.role !== 'admin') {
    sendError(res, 'Permission denied', 403);
    return;
  }

  // Check if user exists
  const targetUser = await UserOperations.getById(targetUserId);
  if (!targetUser) {
    sendError(res, 'User not found', 404);
    return;
  }

  // Check if already member
  const isAlreadyMember = await TeamOperations.isMember(teamId, targetUserId);
  if (isAlreadyMember) {
    sendError(res, 'User is already a member of this team', 409);
    return;
  }

  await TeamOperations.addMember(teamId, targetUserId, memberRole || 'member');

  await logAuditOperation(userId, 'add_team_member', team.name, { teamId, targetUserId, role: memberRole }, req as any);

  // 推送 WebSocket 消息：成员表已更新，按「加入之后」的成员集合投递，
  // 新成员本人也能收到（他此刻已具备读权限）
  await pushTeamEvent(teamId, null, {
    type: 'team_member_added',
    data: {
      teamId,
      userId: targetUserId,
      role: memberRole || 'member',
    },
  });

  sendSuccess(res);
}));

/**
 * @swagger
 * /api/teams/{id}/members/{userId}:
 *   put:
 *     summary: Update member role
 *     tags: [Teams]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [role]
 *             properties:
 *               role:
 *                 type: string
 *                 enum: [admin, member]
 *     responses:
 *       200:
 *         description: Member role updated
 */
router.put('/:id/members/:userId', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const teamId = parseInt(req.params.id);
  const targetUserId = parseInt(req.params.userId);
  const { role: newRole } = req.body as { role: 'admin' | 'member' };
  const userId = req.user!.userId;
  const role = req.user!.role;

  const team = await TeamOperations.getById(teamId) as Team | undefined;
  if (!team) {
    sendError(res, 'Team not found', 404);
    return;
  }

  // Check permission (admin or creator)
  const member = await TeamOperations.getMemberWithRole(teamId, userId);
  if (!isSuper(role) && team.created_by !== userId && member?.role !== 'admin') {
    sendError(res, 'Permission denied', 403);
    return;
  }

  // Cannot change own role
  if (targetUserId === userId) {
    sendError(res, 'Cannot change your own role');
    return;
  }

  await TeamOperations.updateMemberRole(teamId, targetUserId, newRole);

  await logAuditOperation(userId, 'update_team_member_role', team.name, { teamId, targetUserId, newRole }, req as any);
  sendSuccess(res);
}));

/**
 * @swagger
 * /api/teams/{id}/members/{userId}:
 *   delete:
 *     summary: Remove member from team
 *     tags: [Teams]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Member removed
 */
router.delete('/:id/members/:userId', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const teamId = parseInt(req.params.id);
  const targetUserId = parseInt(req.params.userId);
  const userId = req.user!.userId;
  const role = req.user!.role;

  const team = await TeamOperations.getById(teamId) as Team | undefined;
  if (!team) {
    sendError(res, 'Team not found', 404);
    return;
  }

  // Check permission (admin or creator)
  const member = await TeamOperations.getMemberWithRole(teamId, userId);
  if (!isSuper(role) && team.created_by !== userId && member?.role !== 'admin') {
    sendError(res, 'Permission denied', 403);
    return;
  }

  // Cannot remove creator
  if (targetUserId === team.created_by) {
    sendError(res, 'Cannot remove team creator');
    return;
  }

  // 收件人按「移除之前」的成员集合算：被移除的人刚失去权限，让他知道
  // 自己已不在团队里，比静默丢权限更安全（该信息他在移除前本就可见）
  const removedMemberAudience = await getTeamAudienceUserIds(teamId);
  await TeamOperations.removeMember(teamId, targetUserId);

  await logAuditOperation(userId, 'remove_team_member', team.name, { teamId, targetUserId }, req as any);

  // 推送 WebSocket 消息：只推给团队成员与超管
  await pushTeamEvent(teamId, removedMemberAudience, {
    type: 'team_member_removed',
    data: {
      teamId,
      userId: targetUserId,
    },
  });

  sendSuccess(res);
}));

/**
 * @swagger
 * /api/teams/{id}/domain-permissions:
 *   get:
 *     summary: Get team domain permissions
 *     tags: [Teams]
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
 *         description: List of permissions
 */
router.get('/:id/domain-permissions', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const teamId = parseInt(req.params.id);
  const userId = req.user!.userId;
  const role = req.user!.role;
  const tokenPayload = (req as any).tokenPayload;

  const team = await TeamOperations.getById(teamId) as Team | undefined;
  if (!team) {
    sendError(res, 'Team not found', 404);
    return;
  }

  // Check permission
  const member = await TeamOperations.getMemberWithRole(teamId, userId);
  if (!isSuper(role) && team.created_by !== userId && member?.role !== 'admin') {
    sendError(res, 'Permission denied', 403);
    return;
  }

  const permissions = await DomainPermissionOperations.getByTeamId(teamId);

  // For Session auth, convert Punycode to Unicode; for Token auth, keep raw
  const displayPermissions = tokenPayload ? permissions : permissions.map((p: any) => ({
    ...p,
    domain_name: p.domain_name ? getDisplayDomain(p.domain_name, true) : p.domain_name,
  }));

  sendSuccess(res, displayPermissions);
}));

/**
 * @swagger
 * /api/teams/{id}/domain-permissions:
 *   post:
 *     summary: Add domain permission for team
 *     tags: [Teams]
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
 *             required: [domain_id, permission]
 *             properties:
 *               domain_id:
 *                 type: integer
 *               permission:
 *                 type: string
 *                 enum: [read, write]
 *               sub:
 *                 type: string
 *     responses:
 *       200:
 *         description: Permission added
 */
router.post('/:id/domain-permissions', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const teamId = parseInt(req.params.id);
  const { domain_id, permission, sub } = req.body as { domain_id: number; permission: 'read' | 'write'; sub?: string };
  const userId = req.user!.userId;
  const role = req.user!.role;

  const team = await TeamOperations.getById(teamId) as Team | undefined;
  if (!team) {
    sendError(res, 'Team not found', 404);
    return;
  }

  // Check permission
  const member = await TeamOperations.getMemberWithRole(teamId, userId);
  if (!isSuper(role) && team.created_by !== userId && member?.role !== 'admin') {
    sendError(res, 'Permission denied', 403);
    return;
  }

  // 域名归属校验：否则任意登录用户可给自己团队授予他人域名的写权限（P0）
  const owned = await requireDomainOwnership(domain_id, userId, role);
  if (owned !== 'ok') {
    sendError(res, owned === 'not_found' ? 'Domain not found' : 'Permission denied', owned === 'not_found' ? 404 : 403);
    return;
  }

  // Check if already exists
  const existing = await DomainPermissionOperations.getByTeamDomainAndSub(teamId, domain_id, sub || '');
  if (existing) {
    sendError(res, 'Permission already exists for this domain', 409);
    return;
  }

  await DomainPermissionOperations.create({
    domain_id,
    team_id: teamId,
    permission,
    sub: sub || '',
  });

  await logAuditOperation(userId, 'add_team_domain_permission', team.name, { teamId, domainId: domain_id, permission, sub }, req as any);
  sendSuccess(res);
}));

/**
 * @swagger
 * /api/teams/{id}/domain-permissions/{permissionId}:
 *   put:
 *     summary: Update team domain permission
 *     tags: [Teams]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: permissionId
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [permission]
 *             properties:
 *               permission:
 *                 type: string
 *                 enum: [read, write]
 *     responses:
 *       200:
 *         description: Permission updated
 */
router.put('/:id/domain-permissions/:permissionId', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const teamId = parseInt(req.params.id);
  const permissionId = parseInt(req.params.permissionId);
  const { permission } = req.body as { permission: 'read' | 'write' };
  const userId = req.user!.userId;
  const role = req.user!.role;

  const team = await TeamOperations.getById(teamId) as Team | undefined;
  if (!team) {
    sendError(res, 'Team not found', 404);
    return;
  }

  // Check permission
  const member = await TeamOperations.getMemberWithRole(teamId, userId);
  if (!isSuper(role) && team.created_by !== userId && member?.role !== 'admin') {
    sendError(res, 'Permission denied', 403);
    return;
  }

  // 归属校验：域名主授予 read 后，团队管理员不得自行改成 write（提权）
  const permRow = await DomainPermissionOperations.getById(permissionId);
  if (!permRow || permRow.team_id !== teamId) {
    sendError(res, 'Permission not found', 404);
    return;
  }
  const ownedForPut = await requireDomainOwnership(permRow.domain_id, userId, role);
  if (ownedForPut !== 'ok') {
    sendError(res, 'Permission denied', 403);
    return;
  }

  // 带 team_id 约束：否则 A 团队管理员可改 B 团队/他人授权行
  await DomainPermissionOperations.updatePermissionByTeam(permissionId, teamId, permission);
  invalidateAccessCache();

  await logAuditOperation(userId, 'update_team_domain_permission', team.name, { teamId, permissionId, permission }, req as any);
  sendSuccess(res);
}));

/**
 * @swagger
 * /api/teams/{id}/domain-permissions/{permissionId}:
 *   delete:
 *     summary: Remove team domain permission
 *     tags: [Teams]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: permissionId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Permission removed
 */
router.delete('/:id/domain-permissions/:permissionId', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const teamId = parseInt(req.params.id);
  const permissionId = parseInt(req.params.permissionId);
  const userId = req.user!.userId;
  const role = req.user!.role;

  const team = await TeamOperations.getById(teamId) as Team | undefined;
  if (!team) {
    sendError(res, 'Team not found', 404);
    return;
  }

  // Check permission
  const member = await TeamOperations.getMemberWithRole(teamId, userId);
  if (!isSuper(role) && team.created_by !== userId && member?.role !== 'admin') {
    sendError(res, 'Permission denied', 403);
    return;
  }

  await DomainPermissionOperations.deleteByTeamAndId(permissionId, teamId);
  invalidateAccessCache();

  await logAuditOperation(userId, 'remove_team_domain_permission', team.name, { teamId, permissionId }, req as any);
  sendSuccess(res);
}));

/**
 * @swagger
 * /api/teams/{id}/members/{userId}/domain-permissions:
 *   get:
 *     summary: Get member domain permissions
 *     tags: [Teams]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of permissions
 */
router.get('/:id/members/:userId/domain-permissions', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const teamId = parseInt(req.params.id);
  const targetUserId = parseInt(req.params.userId);
  const userId = req.user!.userId;
  const role = req.user!.role;
  const tokenPayload = (req as any).tokenPayload;

  const team = await TeamOperations.getById(teamId) as Team | undefined;
  if (!team) {
    sendError(res, 'Team not found', 404);
    return;
  }

  // Check permission (admin or creator can view any member's permissions, members can view their own)
  const member = await TeamOperations.getMemberWithRole(teamId, userId);
  if (!isSuper(role) && team.created_by !== userId && member?.role !== 'admin' && userId !== targetUserId) {
    sendError(res, 'Permission denied', 403);
    return;
  }

  // Check if target user is a team member
  const isMember = await TeamOperations.isMember(teamId, targetUserId);
  if (!isMember) {
    sendError(res, 'User is not a member of this team', 404);
    return;
  }

  const permissions = await DomainPermissionOperations.getByUserIdWithDomainName(targetUserId);

  // For Session auth, convert Punycode to Unicode; for Token auth, keep raw
  const displayPermissions = tokenPayload ? permissions : permissions.map((p: any) => ({
    ...p,
    domain_name: p.domain_name ? getDisplayDomain(p.domain_name, true) : p.domain_name,
  }));

  sendSuccess(res, displayPermissions);
}));

/**
 * @swagger
 * /api/teams/{id}/members/{userId}/domain-permissions:
 *   post:
 *     summary: Add domain permission for team member
 *     tags: [Teams]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [domain_id, permission]
 *             properties:
 *               domain_id:
 *                 type: integer
 *               permission:
 *                 type: string
 *                 enum: [read, write]
 *               sub:
 *                 type: string
 *     responses:
 *       200:
 *         description: Permission added
 */
router.post('/:id/members/:userId/domain-permissions', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const teamId = parseInt(req.params.id);
  const targetUserId = parseInt(req.params.userId);
  const { domain_id, permission, sub } = req.body as { domain_id: number; permission: 'read' | 'write'; sub?: string };
  const userId = req.user!.userId;
  const role = req.user!.role;

  const team = await TeamOperations.getById(teamId) as Team | undefined;
  if (!team) {
    sendError(res, 'Team not found', 404);
    return;
  }

  // Check permission
  const member = await TeamOperations.getMemberWithRole(teamId, userId);
  if (!isSuper(role) && team.created_by !== userId && member?.role !== 'admin') {
    sendError(res, 'Permission denied', 403);
    return;
  }

  // 域名归属校验：与团队级授予同一条规则，否则可绕过（P0）
  const owned = await requireDomainOwnership(domain_id, userId, role);
  if (owned !== 'ok') {
    sendError(res, owned === 'not_found' ? 'Domain not found' : 'Permission denied', owned === 'not_found' ? 404 : 403);
    return;
  }

  // Check if target user is a team member
  const isMember = await TeamOperations.isMember(teamId, targetUserId);
  if (!isMember) {
    sendError(res, 'User is not a member of this team');
    return;
  }

  // Check if already exists
  const existing = await DomainPermissionOperations.getByUserDomainAndSub(targetUserId, domain_id, sub || '');
  if (existing) {
    sendError(res, 'Permission already exists for this domain', 409);
    return;
  }

  await DomainPermissionOperations.create({
    domain_id,
    user_id: targetUserId,
    team_id: null,
    permission,
    sub: sub || '',
  });

  await logAuditOperation(userId, 'add_domain_permission', team.name, { teamId, targetUserId, domainId: domain_id, permission, sub }, req as any);
  sendSuccess(res);
}));

/**
 * @swagger
 * /api/teams/{id}/members/{userId}/domain-permissions/{permissionId}:
 *   delete:
 *     summary: Remove domain permission from team member
 *     tags: [Teams]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *       - in: path
 *         name: permissionId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Permission removed
 */
router.delete('/:id/members/:userId/domain-permissions/:permissionId', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const teamId = parseInt(req.params.id);
  const targetUserId = parseInt(req.params.userId);
  const permissionId = parseInt(req.params.permissionId);
  const userId = req.user!.userId;
  const role = req.user!.role;

  const team = await TeamOperations.getById(teamId) as Team | undefined;
  if (!team) {
    sendError(res, 'Team not found', 404);
    return;
  }

  // Check permission
  const member = await TeamOperations.getMemberWithRole(teamId, userId);
  if (!isSuper(role) && team.created_by !== userId && member?.role !== 'admin') {
    sendError(res, 'Permission denied', 403);
    return;
  }

  // 归属校验：否则团队管理员可删除第三方域名主单独授予该成员的授权（横向越权）
  const permRowForDelete = await DomainPermissionOperations.getById(permissionId);
  if (!permRowForDelete || permRowForDelete.user_id !== targetUserId) {
    sendError(res, 'Permission not found', 404);
    return;
  }
  const ownedForDelete = await requireDomainOwnership(permRowForDelete.domain_id, userId, role);
  if (ownedForDelete !== 'ok') {
    sendError(res, 'Permission denied', 403);
    return;
  }

  await DomainPermissionOperations.deleteByUserAndId(permissionId, targetUserId);
  invalidateAccessCache();

  await logAuditOperation(userId, 'remove_domain_permission', team.name, { teamId, targetUserId, permissionId }, req as any);
  sendSuccess(res);
}));

export default router;
