import { api } from './client';
import type { ApiResponse } from './client';

export interface WorkflowActionParam {
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  required: boolean;
  options?: string[];
}

export interface WorkflowActionMeta {
  value: string;
  label: string;
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
  condition?: WorkflowDslNode;
  actions: WorkflowDslNode[];
}

export interface WorkflowRunRecord {
  id: number;
  workflow_id: number;
  trace_id: string;
  status: string;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface WorkflowPayload {
  name: string;
  enabled?: boolean;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  condition?: WorkflowDslNode;
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
  run: (id: number, body: { domainId: number; domainName: string; record: { name: string; type: string; value?: string; oldValue?: string } }) =>
    api.post<ApiResponse<{ status: string; traceId: string; error?: string }>>(`/workflows/${id}/run`, body),
  meta: <T = Array<Record<string, unknown>>>(source: string) =>
    api.get<ApiResponse<{ items: T }>>(`/workflows/meta/${source}`),
};