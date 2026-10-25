import { useQuery } from '@tanstack/react-query';
import { workflowsApi, type WorkflowActionMeta, type WorkflowActionParam } from './workflows-api';

/**
 * 后端 meta 接口的查询封装（动作声明 / 候选值）。
 *
 * 为什么把「哪些参数算依赖、缺了就禁用」抽成纯函数：
 * 级联下拉的行为是多步的（先填域名才有记录候选），埋在组件里既难测，
 * 也容易让「禁用」和「提示先填哪个」两处口径漂移。
 */

export interface MetaCandidate {
  value: string;
  label: string;
  /** 分组名（例如域名所属账号）：有值时下拉按组展示 */
  group?: string;
  /** 附加信息，如源站组当前有多少条源站 */
  records?: number;
  references?: number;
}

/** 规范化后端返回：value 必须是字符串，缺 label 就用 value */
export function normalizeCandidates(items: ReadonlyArray<Record<string, unknown>> | undefined): MetaCandidate[] {
  if (!Array.isArray(items)) return [];
  const out: MetaCandidate[] = [];
  for (const item of items) {
    if (!item || item.value === undefined || item.value === null || item.value === '') continue;
    const value = String(item.value);
    out.push({
      value,
      label: typeof item.label === 'string' && item.label ? item.label : value,
      group: typeof item.group === 'string' && item.group ? item.group : undefined,
      records: typeof item.records === 'number' ? item.records : undefined,
      references: typeof item.references === 'number' ? item.references : undefined,
    });
  }
  return out;
}

/** 候选请求参数：可选依赖 + 必选依赖 + 固定查询参数 */
export function buildSourceParams(
  sourceParams: readonly string[] | undefined,
  sourceOptionalParams: readonly string[] | undefined,
  sourceQuery: Record<string, string> | undefined,
  args: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  // 可选项：有值就带上，没值不影响可用性。
  // 例如 EdgeOne 站点类型只对复用 DNSPod 凭据的域名必需，放进必选会把普通账号的下拉也一并禁用。
  for (const key of [...(sourceOptionalParams ?? []), ...(sourceParams ?? [])]) {
    const raw = args[key];
    if (raw !== undefined && raw !== '') out[key] = raw;
  }
  // 固定查询参数最后写：例如 accounts?originGroup=true 的过滤条件不该被实参覆盖
  Object.assign(out, sourceQuery ?? {});
  return out;
}

/** 必选依赖里还没值的键；非空时下拉必须禁用并提示先填哪个 */
export function missingSourceParams(
  sourceParams: readonly string[] | undefined,
  args: Readonly<Record<string, string>>,
): string[] {
  return (sourceParams ?? []).filter((key) => !args[key]);
}

/** 拉取候选（静态源与上游源走同一个端点）；依赖没齐时不发请求 */
export function useMetaSource(
  source: string | undefined,
  params: Readonly<Record<string, string>>,
  options: { enabled?: boolean } = {},
) {
  const ready = Boolean(source) && (options.enabled ?? true);
  const query = useQuery({
    queryKey: ['workflow-meta-candidates', source ?? '', params],
    queryFn: async () => normalizeCandidates(await workflowsApi.meta(source ?? '', { ...params })),
    enabled: ready,
    staleTime: 60_000,
    // 上游失败（凭据错、限流）重试三次只是把等待时间拉长，用户需要的是立刻看到原因
    retry: false,
  });
  return {
    items: query.data ?? [],
    ready,
    isLoading: ready && query.isPending,
    error: query.error instanceof Error ? query.error.message : null,
  };
}

const RISKS: ReadonlyArray<WorkflowActionMeta['risk']> = ['low', 'medium', 'high'];

/** 后端 meta 条目 → 动作声明；字段缺失时给安全默认值（宁可少一列，不要整块崩） */
export function toActionMeta(item: Record<string, unknown>): WorkflowActionMeta {
  const risk = RISKS.find((value) => value === item.risk) ?? 'medium';
  const params = Array.isArray(item.params) ? (item.params as WorkflowActionParam[]) : [];
  return {
    value: String(item.value ?? ''),
    label: typeof item.label === 'string' ? item.label : String(item.value ?? ''),
    description: typeof item.description === 'string' ? item.description : undefined,
    actionClass: typeof item.actionClass === 'string' ? item.actionClass : undefined,
    risk,
    dslVisible: item.dslVisible !== false,
    params,
  };
}

/** 动作声明（含 params / risk / 一句话说明） */
export function useActionMetas() {
  const query = useQuery({
    queryKey: ['workflow-meta-list', 'actions'],
    queryFn: () => workflowsApi.meta('actions'),
    staleTime: 5 * 60_000,
  });
  const items = Array.isArray(query.data) ? query.data.map(toActionMeta) : [];
  return { items, isLoading: query.isPending, error: query.error instanceof Error ? query.error.message : null };
}

/**
 * 触发器声明（含 params）。
 *
 * 源名必须是后端 `STATIC_META_SOURCES` 里的 `triggerTypes`——这里曾写成 `triggers`，
 * 服务端没有该源，每次打开编辑器都 404，参数表单于是永远退回 JSON。
 */
export function useTriggerMetas() {
  const query = useQuery({
    queryKey: ['workflow-meta-list', 'triggerTypes'],
    queryFn: () => workflowsApi.meta('triggerTypes'),
    staleTime: 5 * 60_000,
  });
  const items = Array.isArray(query.data) ? query.data.map(toActionMeta) : [];
  return { items, isLoading: query.isPending, error: query.error instanceof Error ? query.error.message : null };
}
