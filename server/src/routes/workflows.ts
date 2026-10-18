import { Router, Request, Response } from 'express';
import { authMiddleware, adminOnly, requireJwtAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { createLogger } from '../lib/logger';
import { sendError, sendSuccess } from '../utils/http';

function toId(raw: string): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}
import type { ExpressionNode } from '../workflow/expression/nodes';
import { validatePayload, type WorkflowPayload } from '../workflow/validate-payload';
import {
  createWorkflow,
  getStoredById,
  listByOwner,
  listRuns,
  removeWorkflow,
  updateWorkflow,
} from '../workflow/store';

const log = createLogger('HTTP').sub('Route').sub('Workflows');
const router = Router();

function isAdmin(req: Request): boolean {
  return req.user?.role === 3;
}

router.get('/', authMiddleware, adminOnly, asyncHandler(async (req: Request, res: Response) => {
  const ownerId = Number(req.user!.userId);
  const items = await listByOwner(ownerId);
  sendSuccess(res, { total: items.length, items });
}));

router.post('/', authMiddleware, adminOnly, requireJwtAuth('workflows'), asyncHandler(async (req: Request, res: Response) => {
  const payload = req.body as WorkflowPayload;
  const problems = validatePayload(payload);
  if (problems.length) {
    sendError(res, problems.join('; '), 422);
    return;
  }
  const id = await createWorkflow({
    name: String(payload.name),
    ownerId: Number(req.user!.userId),
    enabled: payload.enabled !== false,
    triggerType: String(payload.triggerType),
    triggerConfig: (payload.triggerConfig as Record<string, unknown>) ?? {},
    condition: payload.condition as ExpressionNode | undefined,
    actions: payload.actions as ExpressionNode[],
  });
  log.info('workflow created', { id });
  sendSuccess(res, { id });
}));

router.get('/:id', authMiddleware, adminOnly, asyncHandler(async (req: Request, res: Response) => {
  const item = await getStoredById(toId(req.params.id));
  if (!item) {
    sendError(res, '工作流不存在', 404);
    return;
  }
  if (!isAdmin(req) && item.ownerId !== Number(req.user!.userId)) {
    sendError(res, '无权访问', 403);
    return;
  }
  sendSuccess(res, item);
}));

router.put('/:id', authMiddleware, adminOnly, requireJwtAuth('workflows'), asyncHandler(async (req: Request, res: Response) => {
  const id = toId(req.params.id);
  const existing = await getStoredById(id);
  if (!existing) {
    sendError(res, '工作流不存在', 404);
    return;
  }
  const payload = req.body as WorkflowPayload;
  const merged: WorkflowPayload = {
    name: payload.name ?? existing.name,
    triggerType: payload.triggerType ?? existing.triggerType,
    triggerConfig: payload.triggerConfig ?? existing.triggerConfig,
    condition: payload.condition ?? existing.condition,
    actions: payload.actions ?? existing.actions,
  };
  const problems = validatePayload(merged);
  if (problems.length) {
    sendError(res, problems.join('; '), 422);
    return;
  }
  await updateWorkflow(id, {
    name: payload.name as string | undefined,
    enabled: payload.enabled as boolean | undefined,
    triggerType: payload.triggerType as string | undefined,
    triggerConfig: payload.triggerConfig as Record<string, unknown> | undefined,
    condition: payload.condition as ExpressionNode | undefined,
    actions: payload.actions as ExpressionNode[] | undefined,
  });
  sendSuccess(res);
}));

router.delete('/:id', authMiddleware, adminOnly, requireJwtAuth('workflows'), asyncHandler(async (req: Request, res: Response) => {
  const id = toId(req.params.id);
  const existing = await getStoredById(id);
  if (!existing) {
    sendError(res, '工作流不存在', 404);
    return;
  }
  await removeWorkflow(id);
  sendSuccess(res);
}));

router.get('/:id/runs', authMiddleware, adminOnly, asyncHandler(async (req: Request, res: Response) => {
  const id = toId(req.params.id);
  const runs = await listRuns(id, toId(req.query.limit as string) || 50);
  sendSuccess(res, { total: runs.length, runs });
}));

router.post('/:id/test', authMiddleware, adminOnly, requireJwtAuth('workflows'), asyncHandler(async (req: Request, res: Response) => {
  const item = await getStoredById(toId(req.params.id));
  if (!item) {
    sendError(res, '工作流不存在', 404);
    return;
  }
  const problems = validatePayload({
    name: item.name,
    triggerType: item.triggerType,
    triggerConfig: item.triggerConfig,
    condition: item.condition,
    actions: item.actions,
  });
  sendSuccess(res, { ok: problems.length === 0, issues: problems });
}));

export default router;