import { Router, Request, Response } from 'express';
import { authMiddleware, adminOnly, requireJwtAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { createLimiter } from '../middleware/rateLimit';
import {
  InvalidSyntheticEventError,
  WorkflowNotRunningError,
  getOutboundAllowlist,
  runWorkflowManually,
} from '../workflow';
import { createLogger } from '../lib/logger';
import { sendError, sendSuccess } from '../utils/http';

function toId(raw: string): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}
import type { ExpressionNode } from '../workflow/expression/nodes';
import { DnsAccountOperations, DomainOperations, TeamOperations } from '../db/bal/business-adapter';
import { isSuper } from '../utils/roles';
import { buildStaticMeta, isStaticMetaSource } from '../workflow/meta';
import { DnsProviderService } from '../service/dns-provider-service';
import { getProviderMetaSource } from '../lib/dns/providers/meta-sources';

import '../lib/dns/providers/tencenteo/meta-source';
import '../lib/dns/providers/virtual/meta-source';
import { validatePayload, type WorkflowPayload } from '../workflow/validate-payload';
import {
  WorkflowStoreError,
  createWorkflow,
  getStoredById,
  getWorkflowMetaById,
  latestSampleEvent,
  listByOwner,
  listRuns,
  removeWorkflow,
  updateWorkflow,
} from '../workflow/store';

const log = createLogger('HTTP').sub('Route').sub('Workflows');
const router = Router();

/**
 * 载入并校验工作流归属：不存在 404；非本人且非超管 403。
 * 设计依据：审核团 P0-C（此前 PUT/DELETE/run/runs/sample-event 缺 owner 校验）。
 */
async function loadOwnedWorkflow(req: Request, res: Response, id: number) {
  let item: Awaited<ReturnType<typeof getStoredById>>;
  try {
    item = await getStoredById(id);
  } catch (error) {
    // 只有**数据损坏**才映射成 422；其它异常（DB 不可用等）必须回落到 500，
    // 否则 5xx 告警丢失，且会把原始 SQL/表名回显给租户。
    if (error instanceof WorkflowStoreError) {
      sendError(res, error.message, 422);
      return null;
    }
    throw error;
  }
  if (!item) {
    sendError(res, '工作流不存在', 404);
    return null;
  }
  const requesterId = Number(req.user!.userId);
  const superAdmin = req.user?.role === 3;
  if (!superAdmin && item.ownerId !== requesterId) {
    sendError(res, '无权访问该工作流', 403);
    return null;
  }
  return item;
}

router.get('/', authMiddleware, adminOnly, asyncHandler(async (req: Request, res: Response) => {
  const ownerId = Number(req.user!.userId);
  const items = await listByOwner(ownerId);
  sendSuccess(res, { total: items.length, items });
}));

router.post('/', authMiddleware, adminOnly, requireJwtAuth('workflows'), asyncHandler(async (req: Request, res: Response) => {
  const payload = req.body as WorkflowPayload;
  // 前端用 `condition: null` 表示「无条件」，但 null 不是合法节点；
  // 创建语义里 null 与省略等价，必须先归一化，否则新建必然 422 INVALID_NODE。
  const normalized: WorkflowPayload = { ...payload, condition: payload.condition ?? undefined };
  const problems = validatePayload(normalized);
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
    condition: normalized.condition as ExpressionNode | undefined,
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

  // 账号候选源（设计 §3.3 明确列出，此前一直没实现）。
  // 可见性口径与 /api/accounts 一致：超管看全部，其他人按「自己创建 + 所属团队」取。
  if (source === 'accounts') {
    const role = req.user!.role;
    const raw = isSuper(role)
      ? await DnsAccountOperations.getAll()
      : await (async () => {
          const teams = (await TeamOperations.getByUserId(userId)) as unknown as Array<{ id: number }>;
          return DnsAccountOperations.getAccessibleByUserId(userId, teams.map((row) => row.id));
        })();
    const rows = raw as unknown as Array<{ id: number; name: string; enabled?: number | boolean }>;
    sendSuccess(res, {
      items: rows
        .filter((row) => row.enabled === undefined || Boolean(row.enabled))
        .map((row) => ({ value: String(row.id), label: String(row.name) })),
    });
    return;
  }

  // 域名名称联想源（设计 §3.1 的 `[...]` 形态）：dns.record.* 的 domain 参数要的是**域名名称**，
  // 不是 ID；这里返回名称作为 value，label 带上账号便于区分同名域。
  if (source === 'domainNames') {
    const rows = (await DomainOperations.getUserAccessibleDomains(userId)) as unknown as Array<{
      name: string;
      account_name?: string;
    }>;
    sendSuccess(res, {
      items: rows.map((row) => ({
        value: String(row.name),
        label: row.account_name ? `${row.name} (${row.account_name})` : String(row.name),
      })),
    });
    return;
  }

  // 域名候选源：源站组等动作需要按域名定位，不能只给一个「手填域名 ID」的输入框。
  // 口径与 HTTP 读权限一致（创建者 / 直接授权行），避免下拉里出现用户读不到的域名。
  // 带 group（账号名）时前端按账号分组展示——账号是域名的上位，分组才看得出归属。
  if (source === 'domains') {
    const accountFilter = toId(String(req.query.accountId ?? ''));
    let rows = (await DomainOperations.getUserAccessibleDomains(userId)) as unknown as Array<{
      id: number;
      name: string;
      account_name?: string;
      account_id?: number;
    }>;
    if (accountFilter) rows = rows.filter((row) => Number(row.account_id) === accountFilter);
    sendSuccess(res, {
      items: rows.map((row) => ({
        value: String(row.id),
        label: row.account_name ? `${row.name} (${row.account_name})` : String(row.name),
        group: row.account_name || undefined,
      })),
    });
    return;
  }

  // 无 DB 依赖的候选源由纯函数提供，便于单测
  if (isStaticMetaSource(source)) {
    sendSuccess(res, { items: buildStaticMeta(source) });
    return;
  }

  // 提供商侧候选源：核心只按 source 名转发，不 import 具体提供商
  const providerMeta = getProviderMetaSource(source);
  if (providerMeta) {
    const domainId = toId(String(req.query.domainId ?? ''));
    if (!domainId) {
      sendError(res, '缺少 domainId', 422);
      return;
    }
    // 归属校验：不得用他人域名的账号凭据去上游拉数据
    const accessible = await DomainOperations.getUserAccessibleDomains(userId) as unknown as Array<{ id: number }>;
    if (!accessible.some((row) => Number(row.id) === domainId)) {
      sendError(res, '域名不存在', 404);
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
      // 透传前端声明的其它参数（sourceParams），核心不解释其语义
      const extraParams: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.query)) {
        if (key === 'domainId' || typeof value !== 'string') continue;
        extraParams[key] = value;
      }
      const items = await providerMeta.resolve({
        domainId,
        domainName: String(domain.name ?? ''),
        zoneId: String(domain.third_id ?? ''),
        adapter,
        params: extraParams,
      });
      sendSuccess(res, { items });
    } catch (error) {
      sendError(res, error instanceof Error ? error.message : String(error), 502);
    }
    return;
  }

  // 出站白名单（设计 §5.5.1：编辑器需实时展示当前白名单）
  if (source === 'outboundAllowlist') {
    sendSuccess(res, { items: getOutboundAllowlist() });
    return;
  }

  if (source === 'domains') {
    const limit = Math.min(500, Math.max(1, toId(String(req.query.limit ?? '')) || 200));
    const keyword = String(req.query.q ?? '').trim().toLowerCase();
    if (!Number.isFinite(userId)) {
      sendError(res, '缺少可用身份', 401);
      return;
    }
    const rows = (await DomainOperations.getUserAccessibleDomains(userId)) as unknown as Array<{
      id: number;
      name: string;
    }>;
    // 大账号一次性拉全量会拖垮下拉：限制条数并支持前缀过滤
    const filtered = keyword
      ? rows.filter((row) => String(row.name).toLowerCase().includes(keyword))
      : rows;
    const items = filtered.slice(0, limit).map((row) => ({ value: row.name, label: row.name, id: row.id }));
    sendSuccess(res, { total: filtered.length, items });
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
  const item = await loadOwnedWorkflow(req, res, id);
  if (!item) return;
  const event = await latestSampleEvent(id);
  sendSuccess(res, { event });
}));

router.get('/:id', authMiddleware, adminOnly, asyncHandler(async (req: Request, res: Response) => {
  const item = await loadOwnedWorkflow(req, res, toId(req.params.id));
  if (!item) return;
  sendSuccess(res, item);
}));

router.put('/:id', authMiddleware, adminOnly, requireJwtAuth('workflows'), asyncHandler(async (req: Request, res: Response) => {
  const id = toId(req.params.id);
  const existing = await loadOwnedWorkflow(req, res, id);
  if (!existing) return;
  const payload = req.body as WorkflowPayload;
  // axios 会丢弃值为 undefined 的键，因此「清空条件」只能靠显式 null 或省略键区分：
  // 省略 = 保留旧值；显式给 null/undefined 键 = 清空。
  const hasCondition = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'condition');
  const merged: WorkflowPayload = {
    name: payload.name ?? existing.name,
    enabled: payload.enabled,
    triggerType: payload.triggerType ?? existing.triggerType,
    triggerConfig: payload.triggerConfig ?? existing.triggerConfig,
    condition: hasCondition ? (payload.condition ?? undefined) : existing.condition,
    actions: payload.actions ?? existing.actions,
  };
  const problems = validatePayload(merged);
  if (problems.length) {
    sendError(res, problems.join('; '), 422);
    return;
  }
  // 必须用**校验过的合并结果**落库：只传 payload 会让 {"actions": null} 这类输入
  // 通过校验（nullish 回落到旧值）却在落库时被 store 写成 actions: []。
  await updateWorkflow(id, {
    name: merged.name as string | undefined,
    enabled: payload.enabled as boolean | undefined,
    triggerType: merged.triggerType as string,
    triggerConfig: merged.triggerConfig as Record<string, unknown>,
    condition: merged.condition as ExpressionNode | undefined,
    actions: merged.actions as ExpressionNode[],
  });
  sendSuccess(res);
}));

router.delete('/:id', authMiddleware, adminOnly, requireJwtAuth('workflows'), asyncHandler(async (req: Request, res: Response) => {
  const id = toId(req.params.id);
  // 删除不能依赖 definition 解析：否则数据损坏的工作流永远删不掉
  const meta = await getWorkflowMetaById(id);
  if (!meta) {
    sendError(res, '工作流不存在', 404);
    return;
  }
  const requesterId = Number(req.user!.userId);
  if (req.user?.role !== 3 && meta.ownerId !== requesterId) {
    sendError(res, '无权访问该工作流', 403);
    return;
  }
  await removeWorkflow(id);
  sendSuccess(res);
}));

router.get('/:id/runs', authMiddleware, adminOnly, asyncHandler(async (req: Request, res: Response) => {
  const id = toId(req.params.id);
  const item = await loadOwnedWorkflow(req, res, id);
  if (!item) return;
  // 负值必须夹到合法区间：SQLite 的 LIMIT -5 等于「无上限」
  const runsLimit = Math.min(200, Math.max(1, toId(String(req.query.limit ?? '')) || 50));
  const runs = await listRuns(id, runsLimit);
  sendSuccess(res, { total: runs.length, runs });
}));

const runLimiter = createLimiter(60_000, 10, '手动运行过于频繁，请稍后再试');

router.post('/:id/run', authMiddleware, adminOnly, requireJwtAuth('workflows'), runLimiter, asyncHandler(async (req: Request, res: Response) => {
  const id = toId(req.params.id);
  const item = await loadOwnedWorkflow(req, res, id);
  if (!item) return;

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
  let resolvedName = domainName;
  if ((!Number.isFinite(domainId) || domainId <= 0) && domainName) {
    const found = (await DomainOperations.getByName(domainName)) as unknown as
      | { id: number; name?: string }
      | undefined;
    if (found) {
      domainId = found.id;
      // 事件里的 id 与 name 必须指向同一个域名，否则快照与审计会失真
      resolvedName = found.name ?? domainName;
    }
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
      domain: { id: domainId, name: resolvedName },
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
    // 并发冲突不是「不存在」：此前一律映射成 404，语义错误
    if (result.status === 'skipped' && result.error === 'concurrent-run') {
      sendError(res, '该工作流正在执行，请稍后再试', 409);
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
  const item = await loadOwnedWorkflow(req, res, toId(req.params.id));
  if (!item) return;
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