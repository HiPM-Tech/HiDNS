import { api } from './client';
import type { ApiResponse } from './client';

export interface WorkflowActionParam {
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  required: boolean;
  options?: string[];
  /** 候选来源，如 'originGroups'；声明后渲染为级联下拉 */
  source?: string;
  /** 拉取候选取自同动作的哪些实参，如 ['domainId']；缺一个就禁用下拉 */
  sourceParams?: string[];
  /** 传了才带上、缺了也不禁用下拉的可选实参 */
  sourceOptionalParams?: string[];
}

export interface WorkflowActionMeta {
  value: string;
  label: string;
  /** i18n key：一句话说明这个动作做什么 */
  description?: string;
  actionClass: string;
  risk: 'low' | 'medium' | 'high';
  dslVisible: boolean;
  params: WorkflowActionParam[];
}

export interface WorkflowDslNode {
  kind: string;
  [key: string]: unknown;
}

export interface WorkflowRecord {
  id: number;
  ownerId: number;
  name: string;
  enabled: boolean;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  /** null 表示显式清空条件（undefined 会被 axios 丢弃，服务端会保留旧值） */
  condition?: WorkflowDslNode | null;
  actions: WorkflowDslNode[];
  /** 服务端无法解析该行时返回占位项；此类行只能删除，不能编辑 */
  corrupted?: boolean;
}

export interface WorkflowRunRecord {
  id: number;
  workflow_id: number;
  trace_id: string;
  status: string;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  /** 触发事件快照（JSON 字符串）；服务端一直有返回，前端此前没用 */
  trigger_event?: string | null;
  /** 调用深度，用于排查「工作流调用工作流」被拒绝的情况 */
  depth?: number | null;
}

export interface WorkflowPayload {
  name: string;
  enabled?: boolean;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  /** null 表示显式清空条件（undefined 会被 axios 丢弃，服务端会保留旧值） */
  condition?: WorkflowDslNode | null;
  actions: WorkflowDslNode[];
}

export const workflowsApi = {
  list: () => api.get<ApiResponse<{ total: number; items: WorkflowRecord[] }>>('/workflows'),
  get: (id: number) => api.get<ApiResponse<WorkflowRecord>>(`/workflows/${id}`),
  create: (data: WorkflowPayload) => api.post<ApiResponse<{ id: number }>>('/workflows', data),
  update: (id: number, data: Partial<WorkflowPayload>) => api.put<ApiResponse<null>>(`/workflows/${id}`, data),
  remove: (id: number) => api.delete<ApiResponse<null>>(`/workflows/${id}`),
  runs: (id: number, limit = 50) =>
    api.get<ApiResponse<{ total: number; runs: WorkflowRunRecord[] }>>(`/workflows/${id}/runs`, { params: { limit } }),
  test: (id: number) => api.post<ApiResponse<{ ok: boolean; issues: string[] }>>(`/workflows/${id}/test`),
  sampleEvent: (id: number) =>
    api.get<ApiResponse<{ event: Record<string, unknown> | null }>>(`/workflows/${id}/sample-event`),
  run: (id: number, body: { domainId: number; domainName: string; record: { name: string; type: string; value?: string; oldValue?: string } }) =>
    api.post<ApiResponse<{ status: string; traceId: string; error?: string }>>(`/workflows/${id}/run`, body),
  meta: <T = Array<Record<string, unknown>>>(source: string, params?: Record<string, string | number>) =>
    api.get<ApiResponse<{ items: T }>>(`/workflows/meta/${source}`, params ? { params } : undefined),
};