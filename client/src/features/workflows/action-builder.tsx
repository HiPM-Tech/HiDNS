import { useId, useMemo, useState } from 'react';
import { alertVariants } from '../../ui/alert';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import {
  Badge, Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch,
} from '../../ui';
import type { WorkflowActionMeta, WorkflowActionParam, WorkflowDslNode } from './workflows-api';
import {
  argIsRef, argRefPath, argText, findUnnamedAction, literalArg, looksPrivateOrigin, readActionRows, writeActionNodes,
  type ActionDraftRow,
} from './workflow-dsl';
import { buildSourceParams, missingSourceParams, useMetaSource } from './use-workflow-meta';
import { resolveActionDescription, resolveActionLabel, resolveParamHint, resolveParamLabel } from './workflow-labels';

/**
 * 动作构建器：按 meta.params 渲染参数表单，编辑结果写回动作 DSL。
 *
 * 数据流是单向的：DSL 文本是唯一真相（父组件持有），这里只做「读 → 渲染 → 回写」。
 * 不用内部状态镜像 DSL，就不用 effect 回填，也不会出现表单与 JSON 各说一套话。
 */

const NO_KEYS: readonly string[] = [];
/** 空数组常量：用 `?? []` 会让 useMemo 的依赖每次渲染都变，导致缓存失效与 lint 警告 */
const NO_PARAMS_LIST: WorkflowActionParam[] = [];
const NO_PARAMS: Readonly<Record<string, string>> = {};

/** 风险等级 → 徽标；等级来自后端 meta，界面不该自己发明一档 */
const RISK_BADGE: Record<string, { label: string; variant: 'success' | 'warning' | 'destructive' }> = {
  low: { label: '低风险', variant: 'success' },
  medium: { label: '中风险', variant: 'warning' },
  high: { label: '高风险', variant: 'destructive' },
};

export interface ActionBuilderProps {
  /** 由 DSL 文本解析出来的动作节点 */
  nodes: WorkflowDslNode[];
  /** 回写：拿到的是完整的动作数组，父组件负责序列化进 DSL 文本 */
  onChange: (nodes: WorkflowDslNode[]) => void;
  metas: WorkflowActionMeta[];
  /** DSL 解析失败原因：非空时不渲染卡片，避免把非法文本覆盖成空数组 */
  parseError?: string | null;
}

export function ActionBuilder({ nodes, onChange, metas, parseError }: ActionBuilderProps) {
  // 默认展开第一条：绝大多数工作流只有一两个动作，进来看不到参数等于白搭
  const [selected, setSelected] = useState<number | null>(0);
  const rows = useMemo(() => readActionRows(nodes), [nodes]);
  const metaMap = useMemo(() => new Map(metas.map((meta) => [meta.value, meta])), [metas]);
  const unnamed = findUnnamedAction(rows);

  const commit = (next: ActionDraftRow[]) => onChange(writeActionNodes(next));

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    // 用映射而不是原地交换：返回新数组，避免改动 useMemo 派生出来的 rows
    commit(rows.map((row, position) => (position === index ? rows[target] : position === target ? rows[index] : row)));
    setSelected(target);
  };

  const remove = (index: number) => {
    commit(rows.filter((_, position) => position !== index));
    setSelected((current) => {
      if (current === null) return null;
      if (current === index) return null;
      return current > index ? current - 1 : current;
    });
  };

  const add = () => {
    // 空 kind 先落进 DSL 再让用户选类型：行必须存在于 DSL 里，
    // 否则「添加动作」在视觉上毫无反馈（空行无法序列化）。
    commit([...rows, { kind: '', args: {} }]);
    setSelected(rows.length);
  };

  const patchRow = (index: number, next: ActionDraftRow) => {
    commit(rows.map((row, position) => (position === index ? next : row)));
  };

  return (
    <div className="space-y-2">
      {parseError ? (
        <p role="alert" className={alertVariants('error', 'text-xs')}>
          动作 DSL 解析失败：{parseError}。请先展开下方「高级：直接编辑动作 DSL」修正，期间可视化编辑不可用。
        </p>
      ) : null}

      {!parseError && rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          还没有动作。工作流至少需要一个动作才会执行。
        </p>
      ) : null}

      {rows.map((row, index) => {
        const meta = metaMap.get(row.kind);
        const risk = meta ? RISK_BADGE[meta.risk] : undefined;
        const open = selected === index;
        const title = row.raw ? '自定义节点（只能在高级 DSL 里编辑）' : row.kind || '未选择动作类型';
        const description = row.raw
          ? '该节点不是 call/assign(call)，可视化表单表达不了，保存时会原样写回。'
          : meta
            ? resolveActionDescription(meta)
            : '这个动作不在当前后端声明里，参数请到高级 DSL 里填。';
        return (
          <div key={index} className="rounded-md border border-border bg-background">
            <div className="flex items-start gap-2 p-2">
              <span className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
                {index + 1}
              </span>
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                aria-expanded={open}
                onClick={() => setSelected(open ? null : index)}
              >
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary" className="font-mono">{title}</Badge>
                  {risk ? <Badge variant={risk.variant}>{risk.label}</Badge> : null}
                  {row.saveAs ? <Badge variant="outline">存入变量 {row.saveAs}</Badge> : null}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">{description}</span>
              </button>
              <div className="flex shrink-0 items-center gap-0.5">
                <Button
                  variant="ghost" size="icon" aria-label={`上移第 ${index + 1} 个动作`}
                  disabled={index === 0} onClick={() => move(index, -1)}
                >
                  <ChevronUp className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost" size="icon" aria-label={`下移第 ${index + 1} 个动作`}
                  disabled={index === rows.length - 1} onClick={() => move(index, 1)}
                >
                  <ChevronDown className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10"
                  aria-label={`删除第 ${index + 1} 个动作`} onClick={() => remove(index)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {open ? (
              row.raw ? (
                <pre className="max-h-40 overflow-auto border-t border-border p-2 font-mono text-[11px] text-muted-foreground">
                  {JSON.stringify(row.raw, null, 2)}
                </pre>
              ) : (
                <ActionParams
                  row={row}
                  metas={metas}
                  onChange={(next) => patchRow(index, next)}
                />
              )
            ) : null}
          </div>
        );
      })}

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={add}>
          <Plus className="h-4 w-4" /> 添加动作
        </Button>
        {unnamed !== null ? <span className="text-xs text-destructive">第 {unnamed + 1} 个动作还没选动作类型</span> : null}
      </div>
    </div>
  );
}

/** 单条动作的参数表单（同时负责动作类型选择与变量名） */
function ActionParams({ row, metas, onChange }: {
  row: ActionDraftRow;
  metas: WorkflowActionMeta[];
  onChange: (next: ActionDraftRow) => void;
}) {
  const kindId = useId();
  const meta = metas.find((item) => item.value === row.kind);
  const params = meta?.params ?? NO_PARAMS_LIST;
  const paramLabels = useMemo(
    () => Object.fromEntries(params.map((param) => [param.key, resolveParamLabel(param)])),
    [params],
  );
  // dslVisible === false 的动作（批量写、删记录）不列进下拉，但已配置的要能显示出来
  const options = metas.filter((item) => item.dslVisible || item.value === row.kind);

  return (
    <div className="space-y-3 border-t border-border p-3">
      <div className="space-y-1">
        <Label htmlFor={kindId}>动作类型</Label>
        <Select
          value={row.kind || undefined}
          onValueChange={(next) => {
            // 换动作就清空实参：旧动作的键对新动作没有意义，留着会变成运行期报错
            onChange({ ...row, kind: next, args: {} });
          }}
        >
          <SelectTrigger id={kindId}>
            <SelectValue placeholder="选择动作" />
          </SelectTrigger>
          <SelectContent>
            {options.map((item) => (
              <SelectItem key={item.value} value={item.value}>{resolveActionLabel(item)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {params.length === 0 ? (
        <p className="text-xs text-muted-foreground">这个动作不需要参数。</p>
      ) : params.map((param) => (
        <ActionParamField
          key={param.key}
          param={param}
          paramLabels={paramLabels}
          row={row}
          onChange={(node) => {
            const args = { ...row.args };
            if (node) args[param.key] = node;
            else delete args[param.key];
            onChange({ ...row, args });
          }}
        />
      ))}

      <div className="space-y-1">
        <Label htmlFor={kindId + '-saveAs'}>结果存入变量（可选）</Label>
        <Input
          id={kindId + '-saveAs'}
          value={row.saveAs ?? ''}
          placeholder="例如 diffDigest：后续步骤可用 vars.diffDigest 引用"
          onChange={(event) => onChange({ ...row, saveAs: event.target.value || undefined })}
        />
      </div>
    </div>
  );
}

/** 一个参数控件：控件类型由 meta 决定，写回的永远是 DSL 节点 */
function ActionParamField({ param, paramLabels, row, onChange }: {
  param: WorkflowActionParam;
  paramLabels: Record<string, string>;
  row: ActionDraftRow;
  onChange: (node: WorkflowDslNode | null) => void;
}) {
  const id = useId();
  const node = row.args[param.key];
  const text = argText(node);
  const label = paramLabels[param.key] ?? param.key;
  // 候选依赖：即使当前没渲染下拉也要算，保持 hook 调用顺序稳定
  const cascadeArgs = useMemo(() => {
    const out: Record<string, string> = {};
    for (const key of [...(param.sourceParams ?? NO_KEYS), ...(param.sourceOptionalParams ?? NO_KEYS)]) {
      out[key] = argText(row.args[key]);
    }
    return out;
  }, [param.sourceParams, param.sourceOptionalParams, row.args]);
  const missing = missingSourceParams(param.sourceParams, cascadeArgs);
  const query = useMemo(
    () => buildSourceParams(param.sourceParams, param.sourceOptionalParams, param.sourceQuery, cascadeArgs),
    [param.sourceParams, param.sourceOptionalParams, param.sourceQuery, cascadeArgs],
  );

  const hint = resolveParamHint(param.hint);
  const invalid = param.validation === 'public-origin' && looksPrivateOrigin(text)
    ? '这是内网 / 回环地址，服务端会拒绝该源站。'
    : param.validation === 'must-be-true' && text !== 'true'
      ? '该参数必须是「是」，否则动作不会执行。'
      : null;

  let control;
  if (argIsRef(node)) {
    // 引用事件字段：值要到运行时才有，界面只标出引用了什么，清掉才能改回固定值
    control = (
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono">引用 {argRefPath(node)}</Badge>
        <Button variant="ghost" size="sm" onClick={() => onChange(null)}>改为固定值</Button>
      </div>
    );
  } else if (param.source && !param.allowFreeInput) {
    control = (
      <CascadeSelect
        id={id}
        param={param}
        query={query}
        missing={missing}
        missingLabels={missing.map((key) => paramLabels[key] ?? key)}
        value={text}
        onChange={(next) => onChange(next ? literalArg(param.type, next) : null)}
      />
    );
  } else if (param.source || param.suggestSource) {
    // allowFreeInput 的 source 与 suggestSource 同形：候选列不出来时也得让人手填
    control = (
      <SuggestInput
        id={id}
        source={param.source ?? param.suggestSource}
        query={param.source ? query : NO_PARAMS}
        enabled={missing.length === 0}
        value={text}
        placeholder={label}
        onChange={(next) => onChange(next ? literalArg(param.type, next) : null)}
      />
    );
  } else if (param.options && param.options.length > 0) {
    control = (
      <Select value={text || undefined} onValueChange={(next) => onChange(next ? literalArg(param.type, next) : null)}>
        <SelectTrigger id={id}><SelectValue placeholder={'选择' + label} /></SelectTrigger>
        <SelectContent>
          {param.options.map((option) => (
            <SelectItem key={option} value={option}>{option}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else if (param.type === 'boolean') {
    control = (
      <div className="flex items-center gap-2">
        <Switch
          id={id}
          checked={text === 'true'}
          onCheckedChange={(checked) => onChange({ kind: 'literal', value: checked })}
        />
        <span className="text-xs text-muted-foreground">{text === 'true' ? '是' : '否'}</span>
      </div>
    );
  } else if (param.type === 'number') {
    control = (
      <Input
        id={id}
        type="number"
        value={text}
        placeholder={label}
        onChange={(event) => onChange(event.target.value === '' ? null : literalArg('number', event.target.value))}
      />
    );
  } else {
    control = (
      <Input
        id={id}
        value={text}
        placeholder={label}
        onChange={(event) => onChange(literalArg(param.type, event.target.value))}
      />
    );
  }

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>
        {label}
        {param.required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {control}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {invalid ? <p className="text-xs text-destructive">{invalid}</p> : null}
    </div>
  );
}

/** 级联下拉：依赖实参没值时禁用，并说清缺哪个 */
function CascadeSelect({ id, param, query, missing, missingLabels, value, onChange }: {
  id: string;
  param: WorkflowActionParam;
  query: Record<string, string>;
  missing: string[];
  missingLabels: string[];
  value: string;
  onChange: (next: string) => void;
}) {
  const candidates = useMetaSource(param.source, query, { enabled: missing.length === 0 });
  const options = useMemo(() => {
    const list = candidates.items.map((item) => ({
      value: item.value,
      // 有分组（如域名所属账号）时带上组名：同名域在不同账号下必须能分辨
      label: item.group ? item.label + ' · ' + item.group : item.label,
    }));
    // 当前值可能来自旧数据或已被上游删除：不在候选里也要显示，否则下拉看起来像「没选」
    if (value && !list.some((item) => item.value === value)) list.unshift({ value, label: value + '（当前值）' });
    return list;
  }, [candidates.items, value]);

  return (
    <div className="space-y-1">
      <Select value={value || undefined} onValueChange={onChange} disabled={missing.length > 0}>
        <SelectTrigger id={id}>
          <SelectValue
            placeholder={missing.length > 0 ? '请先填写依赖参数' : candidates.isLoading ? '加载中…' : '选择候选值'}
          />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {missing.length > 0 ? (
        <p className="text-xs text-muted-foreground">请先填写「{missingLabels.join('、')}」，再回到这里选择。</p>
      ) : null}
      {candidates.error ? <p className="text-xs text-destructive">{candidates.error}</p> : null}
    </div>
  );
}

/** 可自由输入 + 候选建议：用原生 datalist，不引第三方组件 */
function SuggestInput({ id, source, query, enabled, value, placeholder, onChange }: {
  id: string;
  source?: string;
  query: Readonly<Record<string, string>>;
  enabled: boolean;
  value: string;
  placeholder?: string;
  onChange: (next: string) => void;
}) {
  const listId = useId();
  const candidates = useMetaSource(source, query, { enabled });
  return (
    <div className="space-y-1">
      <Input
        id={id}
        list={listId}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={listId}>
        {candidates.items.map((item) => (
          <option key={item.value} value={item.value} label={item.label} />
        ))}
      </datalist>
      {candidates.items.length > 0 ? (
        <p className="text-xs text-muted-foreground">可以直接输入；也可从 {candidates.items.length} 个候选里选。</p>
      ) : null}
    </div>
  );
}