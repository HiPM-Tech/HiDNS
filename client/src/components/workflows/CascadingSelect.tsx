import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Select } from 'tdesign-react';
import { workflowsApi } from '../../api';
import { useI18n } from '../../contexts/I18nContext';

interface CascadingSelectProps {
  param: { key: string; source?: string; sourceParams?: string[]; sourceOptionalParams?: string[] };
  /** 参数键 → 已翻译的可读名称；缺失时回落到原始键 */
  labels?: Record<string, string>;
  args: Record<string, string>;
  value: string;
  onChange: (value: string) => void;
}

/** 按参数声明的 source 拉取候选（如 originGroups 依赖 domainId） */
export function CascadingSelect({ param, labels, args, value, onChange }: CascadingSelectProps) {
  const { t } = useI18n();

  const params = useMemo(() => {
    const out: Record<string, string> = {};
    for (const key of param.sourceParams ?? []) {
      const raw = args[key];
      if (raw) out[key] = raw;
    }
    // 可选项：有值就带上，没值不影响可用性。
    // 例如腾讯云源站组：站点类型只对复用 DNSPod 凭据的域名必需，
    // 放进 sourceParams 会把 EdgeOne 账号的下拉也一并禁用。
    for (const key of param.sourceOptionalParams ?? []) {
      const raw = args[key];
      if (raw) out[key] = raw;
    }
    return out;
  }, [args, param.sourceParams, param.sourceOptionalParams]);

  const ready = (param.sourceParams ?? []).every((key) => Boolean(args[key]));
  const query = useQuery({
    queryKey: ['workflow-meta', param.source, params],
    queryFn: () => workflowsApi.meta<Array<{ value: string; label: string }>>(param.source!, params),
    enabled: Boolean(param.source) && ready,
  });

  const options = (query.data?.data?.data as { items?: Array<{ value: string; label: string }> } | undefined)?.items ?? [];
  const nameOf = (key: string) => labels?.[key] ?? key;
  const missing = (param.sourceParams ?? []).filter((key) => !args[key]).map(nameOf).join(', ');

  return (
    <Select
      placeholder={ready ? nameOf(param.key) : t('workflows.needParams', { params: missing })}
      disabled={!ready}
      loading={query.isLoading}
      value={value}
      options={options.map((item) => ({ label: item.label, value: item.value }))}
      onChange={(next) => onChange(String(next))}
    />
  );
}