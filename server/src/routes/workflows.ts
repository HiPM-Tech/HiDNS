import { Router, Request, Response } from 'express';
import { authMiddleware, adminOnly, requireJwtAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { createLimiter } from '../middleware/rateLimit';
import {
  InvalidSyntheticEventError,
  WorkflowNotRunningError,
  runWorkflowManually,
} from '../workflow';
import { createLogger } from '../lib/logger';
import { sendError, sendSuccess } from '../utils/http';

function toId(raw: string): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}
import type { ExpressionNode } from '../workflow/expression/nodes';
import { DomainOperations } from '../db/bal/business-adapter';
import { buildStaticMeta, isStaticMetaSource } from '../workflow/meta';
import { DnsProviderService } from '../service/dns-provider-service';
import { TencenteoAdapter } from '../lib/dns/providers/tencenteo/adapter';
import { validatePayload, type WorkflowPayload } from '../workflow/validate-payload';
import {
  createWorkflow,
  getStoredById,
  latestSampleEvent,
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

/**
 * 候选值接口：供前端渲染 {...} 下拉 / [...] 可输入。
 * 设计依据：§3.3 候选值来源。**只返回当前用户有权看到的内容**。
 */
router.get('/meta/:source', authMiddleware, adminOnly, asyncHandler(async (req: Request, res: Response) => {
  const source = String(req.params.source);
  const userId = Number(req.user!.userId);

  // 无 DB 依赖的候选源由纯函数提供，便于单测
  if (isStaticMetaSource(source)) {
    sendSuccess(res, { items: buildStaticMeta(source) });
    return;
  }

  // 源站组级联：由域名反查账号与作用域（tencenteo 把 ZoneId 映射在 third_id 上）
  if (source === 'originGroups') {
    const domainId = toId(String(req.query.domainId ?? ''));
    if (!domainId) {
      sendError(res, '缺少 domainId', 422);
      return;
    }
    const domain = (await DomainOperations.getById(domainId)) as unknown as
      | { id: number; name: string; third_id?: string }
      | undefined;
    if (!domain) {
      sendError(res, '域名不存在', 404);
      return;
    }
    try {
      const adapter = await DnsProviderService.getAdapter(domainId);
      if (!(adapter instanceof TencenteoAdapter)) {
        sendError(res, '该域名的提供商不支持源站组', 422);
        return;
      }
      adapter.setZoneInfo(String(domain.third_id ?? ''), String(domain.name ?? ''));
      const groups = await adapter.originGroups().list({ limit: 100 });
      sendSuccess(res, {
        items: groups.map((group) => ({
          value: group.groupId,
          label: group.name || group.groupId,
          records: group.records.length,
          references: group.references.length,
        })),
      });
    } catch (error) {
      sendError(res, error instanceof Error ? error.message : String(error), 502);
    }
    return;
  }

  if (source === 'domains') {
    if (!Number.isFinite(userId)) {
      sendError(res, '缺少可用身份', 401);
      return;
    }
    const rows = (await DomainOperations.getUserAccessibleDomains(userId)) as unknown as Array<{
      id: number;
      name: string;
    }>;
    sendSuccess(res, { items: rows.map((row) => ({ value: row.name, label: row.name, id: row.id })) });
    return;
  }

  sendError(res, `未知候选源: ${source}`, 404);
}));
/**
 * 最近一次运行的事件快照：供前端 `(...)` 用**真实值**渲染，而不是显示变量名。
 * 设计依据：§3.1
 */
router.get('/:id/sample-event', authMiddleware, adminOnly, asyncHandler(async (req: Request, res: Response) => {
  const id = toId(req.params.id);
  const item = await getStoredById(id);
  if (!item) {
    sendError(res, '工作流不存在', 404);
    return;
  }
  const event = await latestSampleEvent(id);
  sendSuccess(res, { event });
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

const runLimiter = createLimiter(60_000, 10, '手动运行过于频繁，请稍后再试');

router.post('/:id/run', authMiddleware, adminOnly, requireJwtAuth('workflows'), runLimiter, asyncHandler(async (req: Request, res: Response) => {
  const id = toId(req.params.id);
  const item = await getStoredById(id);
  if (!item) {
    sendError(res, '工作流不存在', 404);
    return;
  }

  const body = req.body as {
    domainId?: unknown;
    domainName?: unknown;
    record?: { name?: unknown; type?: unknown; value?: unknown; oldValue?: unknown };
  };
  let domainId = Number(body.domainId);
  const domainName = typeof body.domainName === 'string' ? body.domainName : '';
  const record = body.record ?? {};

  // 允许只给域名：合成事件里的 domain.id 必须是真实主键，
  // 否则引擎会把 0 当作 domainId 传给鉴权与动作。
  if ((!Number.isFinite(domainId) || domainId <= 0) && domainName) {
    const found = (await DomainOperations.getByName(domainName)) as unknown as
      | { id: number }
      | undefined;
    if (found) domainId = found.id;
  }

  if (!Number.isFinite(domainId) || domainId <= 0 || !domainName) {
    sendError(res, '需要有效的 domainId 或 domainName 构造合成事件', 422);
    return;
  }
  if (typeof record.name !== 'string' || typeof record.type !== 'string') {
    sendError(res, 'record.name 与 record.type 必填', 422);
    return;
  }

  try {
    const result = await runWorkflowManually(id, {
      domain: { id: domainId, name: domainName },
      record: {
        name: record.name,
        type: record.type,
        value: typeof record.value === 'string' ? record.value : undefined,
        oldValue: typeof record.oldValue === 'string' ? record.oldValue : undefined,
      },
    });
    if (!result) {
      sendError(res, '工作流不存在', 404);
      return;
    }
    sendSuccess(res, result);
  } catch (error) {
    if (error instanceof WorkflowNotRunningError) {
      sendError(res, error.message, 503);
      return;
    }
    if (error instanceof InvalidSyntheticEventError) {
      sendError(res, error.message, 422);
      return;
    }
    throw error;
  }
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