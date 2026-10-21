import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AutoComplete } from 'tdesign-react';
import { workflowsApi } from '../../api';

/**
 * 联想输入（设计 §3.1 的 `[...]` 形态）：可以自由输入，同时给出候选建议。
 *
 * 与 CascadingSelect 的区别：那边只能从候选里选（`{...}`），这边允许填候选之外的值——
 * 例如域名参数：常见的是自己名下的域名，但也允许填尚未纳管的域名。
 */
export function SuggestInput({
  source,
  value,
  placeholder,
  onChange,
}: {
  source: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const query = useQuery({
    queryKey: ['workflow-meta', source],
    queryFn: () => workflowsApi.meta<Array<{ value: string; label: string }>>(source),
    enabled: Boolean(source),
  });

  const items = (query.data?.data?.data as { items?: Array<{ value: string; label: string }> } | undefined)?.items ?? [];
  const options = useMemo(() => items.map((item) => ({ label: item.label, value: item.value })), [items]);

  return (
    <div className="workflow-suggest">
      <AutoComplete
        value={value}
        options={options}
        placeholder={placeholder}
        onChange={(next: any) => onChange(String(next ?? ''))}
      />
    </div>
  );
}
