import { ensureOk, http } from '../../lib/http';

export interface WorkflowDslNode {
  kind: string;
  [key: string]: unknown;
}

export interface WorkflowRow {
  id: number;
  ownerId?: number;
  name: string;
  enabled: boolean;
  triggerType: string;
  triggerConfig?: Record<string, unknown>;
  condition?: WorkflowDslNode | null;
  actions?: WorkflowDslNode[];
  corrupted?: boolean;
}

export interface WorkflowRunRow {
  id: number;
  workflow_id: number;
  trace_id: string;
  status: string;
  started_at?: string;
  finished_at?: string;
  error?: string | null;
}

export interface WorkflowPayload {
  name: string;
  enabled?: boolean;
  triggerType: string;
  triggerConfig?: Record<string, unknown>;
  condition?: WorkflowDslNode | null;
  actions: WorkflowDslNode[];
}

/** 动作参数声明：与后端 server/src/workflow/actions/types.ts 的 ActionParam 对齐 */
export interface WorkflowActionParam {
  key: string;
  /** 后端给的是 i18n 键，展示前由 workflow-labels 翻成中文 */
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select' | 'multiselect';
  required: boolean;
  hint?: string;
  /** 声明式前端校验：public-origin = 不能是内网/回环；must-be-true = 必须勾选 */
  validation?: 'public-origin' | 'must-be-true';
  options?: string[];
  /** 候选来源；声明后渲染为下拉（只能选），依赖 sourceParams */
  source?: string;
  /** 拉取候选取自同一条动作的哪些实参；缺一个就禁用下拉 */
  sourceParams?: string[];
  /** 传了才带上、缺了也不禁用下拉的可选实参 */
  sourceOptionalParams?: string[];
  /** 静态查询参数：随候选请求一起发送（如 accounts?originGroup=true） */
  sourceQuery?: Record<string, string>;
  /** 允许直接填写（候选列不出来时仍能继续），渲染为可输入 + 建议 */
  allowFreeInput?: boolean;
  /** 联想来源：可自由输入，同时给候选建议（域名这类参数常用） */
  suggestSource?: string;
}

/** 动作声明（GET /workflows/meta/actions 的一项） */
export interface WorkflowActionMeta {
  value: string;
  label: string;
  description?: string;
  actionClass?: string;
  risk: 'low' | 'medium' | 'high';
  /** 是否出现在动作下拉里；false 的（如批量写）只允许手写 DSL */
  dslVisible: boolean;
  params: WorkflowActionParam[];
}

/** meta 端点未定型条目：静态源、上游源、触发器源共用一套信封 */
export interface WorkflowMetaItem extends Record<string, unknown> {
  value: string;
  label: string;
}

async function unwrap<T>(promise: Promise<import('../../lib/http').ApiEnvelope<T>>): Promise<T> {
  const envelope = await promise;
  if (envelope.code !== 0) throw new Error(envelope.msg || '请求失败');
  return envelope.data;
}

export const workflowsApi = {
  list: async (): Promise<WorkflowRow[]> => {
    const data = await unwrap(http.get<{ total?: number; items?: WorkflowRow[] }>('/workflows'));
    return data.items ?? [];
  },
  create: async (payload: WorkflowPayload) => ensureOk(await http.post<{ id: number }>('/workflows', payload)),
  update: async (id: number, payload: Partial<WorkflowPayload>) => ensureOk(await http.put<null>(`/workflows/${id}`, payload)),
  remove: async (id: number) => ensureOk(await http.delete<null>(`/workflows/${id}`)),
  runs: async (id: number, limit = 50): Promise<WorkflowRunRow[]> => {
    const data = await unwrap(http.get<{ total?: number; runs?: WorkflowRunRow[] }>(`/workflows/${id}/runs`, { query: { limit } }));
    return data.runs ?? [];
  },
  test: async (id: number): Promise<{ ok: boolean; issues: string[] }> =>
    unwrap(http.post<{ ok: boolean; issues: string[] }>(`/workflows/${id}/test`)),
  run: async (id: number, body: { domainId: number; domainName: string; record: { name: string; type: string; value?: string; oldValue?: string } }) =>
    unwrap(http.post<{ status: string; traceId: string; error?: string }>(`/workflows/${id}/run`, body)),
  sampleEvent: async (id: number): Promise<Record<string, unknown> | null> => {
    const data = await unwrap(http.get<{ event?: Record<string, unknown> | null }>(`/workflows/${id}/sample-event`));
    return data.event ?? null;
  },
  /**
   * 候选值 / 声明。query 用于级联下拉的依赖参数与 sourceQuery（如 accounts?originGroup=true）：
   * 后端按 source 分流，核心不解释参数语义，只透传给上游适配器。
   */
  meta: async (source: string, query?: Record<string, string>): Promise<WorkflowMetaItem[]> => {
    const data = await unwrap(http.get<{ items?: WorkflowMetaItem[] }>(`/workflows/meta/${source}`, { query }));
    return data.items ?? [];
  },
};

export const RUN_STATUS: Record<string, { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' }> = {
  success: { label: '成功', variant: 'success' },
  partial: { label: '部分成功', variant: 'warning' },
  failed: { label: '失败', variant: 'destructive' },
  skipped: { label: '跳过', variant: 'secondary' },
  running: { label: '执行中', variant: 'warning' },
};

export function runStatus(status?: string) {
  return RUN_STATUS[status ?? ''] ?? { label: status ?? '未知', variant: 'secondary' as const };
}

/** DSL 文本 → 节点数组；解析失败抛出可读原因 */
export function parseDslNodes(text: string): WorkflowDslNode[] {
  if (!text.trim()) return [];
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('动作必须是数组');
  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('第 ' + (index + 1) + ' 个动作不是对象');
    const node = item as Record<string, unknown>;
    if (typeof node.kind !== 'string' || !node.kind) throw new Error('第 ' + (index + 1) + ' 个动作缺少 kind');
    return node as WorkflowDslNode;
  });
}

export function stringifyDsl(nodes?: WorkflowDslNode[] | null): string {
  return JSON.stringify(nodes ?? [], null, 2);
}