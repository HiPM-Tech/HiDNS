import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Select } from 'tdesign-react';
import { workflowsApi } from '../../api';
import { useI18n } from '../../contexts/I18nContext';

/**
 * 候选标签：有计数时拼上「N 条源站 · M 处引用」。
 * 设计 §1106 要求在选择阶段就能看见后果，不能等运行完才发现源站被合并。
 */
export function formatCandidateLabel(
  item: { label: string; records?: number; references?: number },
  t: (key: string, options?: Record<string, string | number>) => string,
): string {
  if (typeof item.records !== 'number') return item.label;
  return `${item.label} · ${t('workflows.originGroupCounts', { records: item.records, references: item.references ?? 0 })}`;
}

/** 候选条目。originGroups 会额外带 records/references，用于在选择阶段就看见后果 */
interface MetaCandidate {
  value: string;
  label: string;
  group?: string;
  /** 该源站组当前有多少条源站 */
  records?: number;
  /** 有多少个工作流引用了它 */
  references?: number;
}

interface CascadingSelectProps {
  param: { key: string; source?: string; sourceParams?: string[]; sourceOptionalParams?: string[] };
  /** 参数键 → 已翻译的可读名称；缺失时回落到原始键 */
  labels?: Record<string, string>;
  /** 参数值可能是字面量也可能是事件引用，这里只关心最终要传给候选源的那个字符串 */
  args: Record<string, { value: string } | undefined>;
  value: string;
  onChange: (value: string) => void;
}

/** 按参数声明的 source 拉取候选（如 originGroups 依赖 domainId） */
export function CascadingSelect({ param, labels, args, value, onChange }: CascadingSelectProps) {
  const { t } = useI18n();

  const params = useMemo(() => {
    const out: Record<string, string> = {};
    for (const key of param.sourceParams ?? []) {
      const raw = args[key]?.value;
      if (raw) out[key] = raw;
    }
    // 可选项：有值就带上，没值不影响可用性。
    // 例如腾讯云源站组：站点类型只对复用 DNSPod 凭据的域名必需，
    // 放进 sourceParams 会把 EdgeOne 账号的下拉也一并禁用。
    for (const key of param.sourceOptionalParams ?? []) {
      const raw = args[key]?.value;
      if (raw) out[key] = raw;
    }
    return out;
  }, [args, param.sourceParams, param.sourceOptionalParams]);

  const ready = (param.sourceParams ?? []).every((key) => Boolean(args[key]?.value));
  const query = useQuery({
    queryKey: ['workflow-meta', param.source, params],
    queryFn: () =>
      workflowsApi.meta<MetaCandidate[]>(param.source!, params),
    enabled: Boolean(param.source) && ready,
  });

  const items = (query.data?.data?.data as { items?: MetaCandidate[] } | undefined)?.items ?? [];

  // 候选带 group（如域名的账号名）时按组展示：账号是域名的上位，
  // 平铺一长串域名看不出归属，用户也就无从判断选的是哪个账号下的资源。
  const options = useMemo(() => {
    const groups = new Map<string, Array<{ label: string; value: string }>>();
    const flat: Array<{ label: string; value: string }> = [];
    for (const item of items) {
      const option = { label: formatCandidateLabel(item, t), value: item.value };
      if (item.group) {
        if (!groups.has(item.group)) groups.set(item.group, []);
        groups.get(item.group)!.push(option);
      } else {
        flat.push(option);
      }
    }
    if (groups.size === 0) return flat;
    return [...Array.from(groups, ([label, groupOptions]) => ({ label, options: groupOptions })), ...flat];
  }, [items, t]);
  const nameOf = (key: string) => labels?.[key] ?? key;
  const missing = (param.sourceParams ?? []).filter((key) => !args[key]?.value).map(nameOf).join(', ');

  const selected = items.find((item) => item.value === value);
  // 设计 §1106：条数 > 1 时必须醒目提示「会把 N 条源站收敛为 1 条」，
  // 让用户在选中的那一刻就知道后果，而不是等到运行后才发现被合并。
  const collapseCount = typeof selected?.records === 'number' && selected.records > 1 ? selected.records : 0;

  return (
    <div className="workflow-cascading">
      <Select
        placeholder={ready ? nameOf(param.key) : t('workflows.needParams', { params: missing })}
        disabled={!ready}
        loading={query.isLoading}
        value={value}
        options={options as any}
        onChange={(next) => onChange(String(next))}
      />
      {collapseCount > 0 ? (
        <div className="workflow-collapse-warning">
          {t('workflows.originGroupCollapseWarning', { count: collapseCount })}
        </div>
      ) : null}
    </div>
  );
}