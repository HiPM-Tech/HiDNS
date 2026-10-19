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
import { getDisplayDomain } from '../utils/dns';

const log = createLogger('HTTP').sub('Route').sub('Teams');
const router = Router();

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
    sendError(res, 'Team name is required');
    return;
  }

  const id = await TeamOperations.create({
    name: name.trim(),
    description: description?.trim() || '',
    created_by: userId,
  });

  // Add creator as admin
  await TeamOperations.addMember(id, userId, 'admin');

  await logAuditOperation(userId, 'create_team', name.trim(), { teamId: id }, req as any);

  // 推送 WebSocket 消息
  try {
    wsService.broadcast({
      type: 'team_created',
      data: {
        teamId: id,
        name: name.trim(),
      },
    });
  } catch (error) {
    log.error('Failed to broadcast team_created event', { error });
  }

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
  if (name !== undefined) updates.name = name.trim();
  if (description !== undefined) updates.description = description.trim();

  await TeamOperations.update(teamId, updates);

  await logAuditOperation(userId, 'update_team', team.name, { teamId, ...updates }, req as any);

  // 推送 WebSocket 消息
  try {
    wsService.broadcast({
      type: 'team_updated',
      data: {
        teamId,
        name: name ?? team.name,
      },
    });
  } catch (error) {
    log.error('Failed to broadcast team_updated event', { error });
  }

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

  await TeamOperations.delete(teamId);

  await logAuditOperation(userId, 'delete_team', team.name, { teamId }, req as any);

  // 推送 WebSocket 消息
  try {
    wsService.broadcast({
      type: 'team_deleted',
      data: {
        teamId,
        name: team.name,
      },
    });
  } catch (error) {
    log.error('Failed to broadcast team_deleted event', { error });
  }

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
    sendError(res, 'User not found');
    return;
  }

  // Check if already member
  const isAlreadyMember = await TeamOperations.isMember(teamId, targetUserId);
  if (isAlreadyMember) {
    sendError(res, 'User is already a member of this team');
    return;
  }

  await TeamOperations.addMember(teamId, targetUserId, memberRole || 'member');

  await logAuditOperation(userId, 'add_team_member', team.name, { teamId, targetUserId, role: memberRole }, req as any);

  // 推送 WebSocket 消息
  try {
    wsService.broadcast({
      type: 'team_member_added',
      data: {
        teamId,
        userId: targetUserId,
        role: memberRole || 'member',
      },
    });
  } catch (error) {
    log.error('Failed to broadcast team_member_added event', { error });
  }

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

  await TeamOperations.removeMember(teamId, targetUserId);

  await logAuditOperation(userId, 'remove_team_member', team.name, { teamId, targetUserId }, req as any);

  // 推送 WebSocket 消息
  try {
    wsService.broadcast({
      type: 'team_member_removed',
      data: {
        teamId,
        userId: targetUserId,
      },
    });
  } catch (error) {
    log.error('Failed to broadcast team_member_removed event', { error });
  }

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
  if (!isSuper(role)) {
    const domain = (await DomainOperations.getById(domain_id)) as unknown as
      | { id: number; account_id: number }
      | undefined;
    if (!domain) {
      sendError(res, 'Domain not found', 404);
      return;
    }
    const createdBy = await DnsAccountOperations.getCreatedBy(domain.account_id);
    if (createdBy !== userId) {
      sendError(res, 'Permission denied', 403);
      return;
    }
  }

  // Check if already exists
  const existing = await DomainPermissionOperations.getByTeamDomainAndSub(teamId, domain_id, sub || '');
  if (existing) {
    sendError(res, 'Permission already exists for this domain');
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

  // Check if target user is a team member
  const isMember = await TeamOperations.isMember(teamId, targetUserId);
  if (!isMember) {
    sendError(res, 'User is not a member of this team');
    return;
  }

  // Check if already exists
  const existing = await DomainPermissionOperations.getByUserDomainAndSub(targetUserId, domain_id, sub || '');
  if (existing) {
    sendError(res, 'Permission already exists for this domain');
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

  await DomainPermissionOperations.deleteByUserAndId(permissionId, targetUserId);
  invalidateAccessCache();

  await logAuditOperation(userId, 'remove_domain_permission', team.name, { teamId, targetUserId, permissionId }, req as any);
  sendSuccess(res);
}));

export default router;
