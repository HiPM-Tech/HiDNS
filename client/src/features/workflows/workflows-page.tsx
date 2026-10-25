import { useId, useMemo, useState } from 'react';
import { alertVariants } from '../../ui/alert';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FlaskConical, History, Loader2, Pencil, Play, Plus, RefreshCw, Trash2, Workflow } from 'lucide-react';
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, Dialog, DialogContent,
  DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Select, SelectContent, SelectItem,
  SelectTrigger, SelectValue, Skeleton, Switch, Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow,
} from '../../ui';
import { formatRelative } from '../../lib/format';
import {
  parseDslNodes, runStatus, stringifyDsl, workflowsApi,
  type WorkflowActionMeta, type WorkflowActionParam, type WorkflowDslNode, type WorkflowPayload,
  type WorkflowRow, type WorkflowRunRow,
} from './workflows-api';
import { ActionBuilder } from './action-builder';
import { ConditionEditor } from './condition-editor';
import { findUnnamedAction, parseConditionJson, readActionRows } from './workflow-dsl';
import { useActionMetas, useTriggerMetas } from './use-workflow-meta';
import { resolveActionLabel, resolveParamLabel, resolveTriggerLabel } from './workflow-labels';

export function WorkflowsPage() {
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<{ mode: 'create' } | { mode: 'edit'; row: WorkflowRow } | null>(null);
  const [runsFor, setRunsFor] = useState<WorkflowRow | null>(null);
  const [runFor, setRunFor] = useState<WorkflowRow | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WorkflowRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 列表里的触发器/动作也要显示中文标签（与编辑器同一份 meta）
  const triggerMetas = useTriggerMetas();
  const actionMetas = useActionMetas();

  const workflows = useQuery({ queryKey: ['workflows'], queryFn: workflowsApi.list, staleTime: 20_000 });
  const invalidate = () => { void queryClient.invalidateQueries({ queryKey: ['workflows'] }); };

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => workflowsApi.update(id, { enabled }),
    onSuccess: invalidate,
  });
  const test = useMutation({ mutationFn: (id: number) => workflowsApi.test(id) });
  const remove = useMutation({ mutationFn: (id: number) => workflowsApi.remove(id), onSuccess: invalidate });

  const rows = workflows.data ?? [];

  const runTest = async (row: WorkflowRow) => {
    setError(null); setNotice(null);
    try {
      const result = await test.mutateAsync(row.id);
      if (result.ok) setNotice(row.name + ' 配置检查通过');
      else setError('配置存在问题：' + result.issues.join('；'));
    } catch (err) { setError(err instanceof Error ? err.message : '检查失败'); }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setError(null);
    try { await remove.mutateAsync(pendingDelete.id); setPendingDelete(null); }
    catch (err) { setError(err instanceof Error ? err.message : '删除失败'); }
  };

  return (
    <div className="space-y-phi-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-heading font-semibold">自动化工作流</h2>
          <p className="text-xs text-muted-foreground">事件触发 → 条件判断 → 动作执行；共 {rows.length} 条</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void workflows.refetch()} disabled={workflows.isFetching}>
            <RefreshCw className={workflows.isFetching ? 'animate-spin' : undefined} /> 刷新
          </Button>
          <Button size="sm" onClick={() => setEditor({ mode: 'create' })}>
            <Plus className="h-4 w-4" /> 新增工作流
          </Button>
        </div>
      </div>

      {error && (
        <div role="alert" className={alertVariants('error', 'flex items-center gap-2')}>
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}
      {notice && (
        <div role="status" className={alertVariants('success')}>
          {notice}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Workflow className="h-4 w-4" /> 工作流列表</CardTitle>
          <CardDescription>动作按 meta 可视化编辑（也可切到 DSL 手写）；出站请求需在系统「工作流白名单」中放行主机名。</CardDescription>
        </CardHeader>
        <CardContent>
          {workflows.isError ? (
            <div className="space-y-2 py-8 text-center">
              <p className="text-sm text-destructive">{workflows.error instanceof Error ? workflows.error.message : '加载失败'}</p>
              <Button variant="outline" size="sm" onClick={() => void workflows.refetch()}>重试</Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-44">名称</TableHead>
                  <TableHead>触发器</TableHead>
                  <TableHead>动作</TableHead>
                  <TableHead>启用</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workflows.isLoading ? (
                  Array.from({ length: 4 }, (_, index) => (
                    <TableRow key={index}><TableCell colSpan={5}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                  ))
                ) : rows.length === 0 ? (
                  <TableEmpty colSpan={5}>还没有工作流</TableEmpty>
                ) : rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <p className="font-medium">{row.name}</p>
                      {row.corrupted && <p className="text-xs text-destructive">该行无法解析，只能删除</p>}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {resolveTriggerLabel({ value: row.triggerType, label: triggerMetas.items.find((item) => item.value === row.triggerType)?.label })}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {(row.actions ?? []).slice(0, 3).map((action, index) => {
                          // 列表展示中文动作名：此前直接打印 DSL 的 kind（call/assign），与编辑器里的中文对不上
                          const name = action.kind === 'call'
                            ? String(action.action ?? '')
                            : action.kind === 'assign'
                              ? String((action.value as { action?: unknown } | undefined)?.action ?? '')
                              : String(action.kind ?? '');
                          const label = resolveActionLabel({ value: name, label: actionMetas.items.find((item) => item.value === name)?.label });
                          return <Badge key={index} variant="secondary">{label || '未选择动作'}</Badge>;
                        })}
                        {(row.actions?.length ?? 0) > 3 && <Badge variant="outline">+{(row.actions?.length ?? 0) - 3}</Badge>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={Boolean(row.enabled)}
                        aria-label={'启用 ' + row.name}
                        disabled={row.corrupted}
                        onCheckedChange={(checked) => { void toggle.mutateAsync({ id: row.id, enabled: checked }); }}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setRunFor(row)} disabled={row.corrupted}>
                          <Play className="h-4 w-4" />运行
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setRunsFor(row)}>
                          <History className="h-4 w-4" />记录
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => void runTest(row)} disabled={test.isPending}>
                          {test.isPending ? <Loader2 className="animate-spin" /> : <FlaskConical className="h-4 w-4" />}检查
                        </Button>
                        <Button variant="ghost" size="icon" aria-label={'编辑 ' + row.name} disabled={row.corrupted} onClick={() => setEditor({ mode: 'edit', row })}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:bg-destructive/10"
                          aria-label={'删除 ' + row.name}
                          onClick={() => setPendingDelete(row)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {editor && (
        <WorkflowEditorDialog
          mode={editor.mode}
          row={editor.mode === 'edit' ? editor.row : undefined}
          onClose={() => setEditor(null)}
          onError={setError}
          onSaved={() => { invalidate(); setEditor(null); setNotice('工作流已保存'); }}
        />
      )}

      {runsFor && (
        <RunHistoryDialog
          workflow={runsFor}
          onClose={() => setRunsFor(null)}
        />
      )}

      {runFor && (
        <RunWorkflowDialog
          workflow={runFor}
          onClose={() => setRunFor(null)}
          onDone={(message) => { setNotice(message); invalidate(); }}
          onError={setError}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除工作流"
        description={<>确认删除 <span className="font-medium text-foreground">{pendingDelete?.name}</span>？历史运行记录会一并清理。</>}
        confirmLabel="确认删除"
        pending={remove.isPending}
        onConfirm={() => void handleDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

function WorkflowEditorDialog({ mode, row, onClose, onError, onSaved }: {
  mode: 'create' | 'edit';
  row?: WorkflowRow;
  onClose: () => void;
  onError: (message: string) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(row?.name ?? '');
  const [enabled, setEnabled] = useState(row?.enabled ?? true);
  const [triggerType, setTriggerType] = useState(row?.triggerType ?? '');
  const [triggerConfig, setTriggerConfig] = useState(JSON.stringify(row?.triggerConfig ?? {}, null, 2));
  const [condition, setCondition] = useState(row?.condition ? JSON.stringify(row.condition, null, 2) : '');
  // 动作 DSL 文本是唯一真相：可视化编辑器写回这里，高级编辑器直接改这里。
  // 不再另存一份表单状态，所以「切到 DSL 时从表单序列化」天然成立，也不会有两处漂移。
  // 新建时先放一个空动作：空白列表里连「动作类型」都无处可选，用户第一眼无从下手
  const [actionsDsl, setActionsDsl] = useState(() => stringifyDsl(row?.actions ?? [{ kind: 'call', action: '', args: {} }]));
  const [showDsl, setShowDsl] = useState(false);
  const [pending, setPending] = useState(false);

  const actionMetas = useActionMetas();
  const triggerMetas = useTriggerMetas();

  // 新建时默认选中第一个触发器：用「用户未选择时的派生值」表达，而不是 effect 回写
  const effectiveTrigger = triggerType || (mode === 'create' ? triggerMetas.items[0]?.value ?? '' : '');

  // DSL 文本 → 动作节点。解析失败时保留原文（不让可视化编辑把非法文本覆盖成空数组），
  // 由 ActionBuilder 提示先到高级编辑里修。
  const actionsState = useMemo(() => {
    try {
      return { nodes: parseDslNodes(actionsDsl), error: null as string | null };
    } catch (err) {
      return { nodes: [] as WorkflowDslNode[], error: err instanceof Error ? err.message : '未知错误' };
    }
  }, [actionsDsl]);

  const submit = async () => {
    if (!name.trim()) { onError('请输入名称'); return; }
    if (!effectiveTrigger.trim()) { onError('请选择触发器类型'); return; }

    let parsedActions: WorkflowDslNode[];
    try {
      // 保存以 DSL 为准：可视化与高级编辑写的是同一份文本，这里再解析一次做结构校验
      parsedActions = parseDslNodes(actionsDsl);
    } catch (err) {
      onError('动作 DSL 解析失败：' + (err instanceof Error ? err.message : '未知错误'));
      return;
    }
    if (parsedActions.length === 0) { onError('至少需要一个动作'); return; }
    // 空动作能通过 parseDslNodes（kind 是 'call' 但 action 为空），运行期才会失败，提前拦住
    const unnamed = findUnnamedAction(readActionRows(parsedActions));
    if (unnamed !== null) { onError(`第 ${unnamed + 1} 个动作还没选动作类型`); return; }

    let parsedConfig: Record<string, unknown> | undefined;
    try {
      parsedConfig = triggerConfig.trim() ? (JSON.parse(triggerConfig) as Record<string, unknown>) : {};
    } catch {
      onError('触发器配置不是合法 JSON');
      return;
    }

    const parsedCondition = parseConditionJson(condition);
    if (!parsedCondition.ok) { onError('条件不是合法 JSON：' + parsedCondition.error); return; }

    setPending(true);
    const payload: WorkflowPayload = {
      name: name.trim(),
      enabled,
      triggerType: effectiveTrigger.trim(),
      triggerConfig: parsedConfig,
      condition: parsedCondition.node,
      actions: parsedActions,
    };
    try {
      if (mode === 'create') await workflowsApi.create(payload);
      else if (row) await workflowsApi.update(row.id, payload);
      onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : '保存失败');
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex max-h-[88vh] w-[min(96vw,52rem)] flex-col gap-0 p-0">
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? '新增工作流' : '编辑工作流'}</DialogTitle>
          <DialogDescription>
            动作按后端声明的 meta 渲染参数；条件与动作都可切回 JSON 手写，两种表示始终同步。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid gap-phi-6 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="wf-name">名称</Label>
              <Input id="wf-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：证书到期通知" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wf-trigger">触发器</Label>
              <Select value={effectiveTrigger} onValueChange={setTriggerType}>
                <SelectTrigger id="wf-trigger"><SelectValue placeholder={triggerMetas.isLoading ? '加载中…' : '选择触发器'} /></SelectTrigger>
                <SelectContent>
                  {triggerMetas.items.map((item) => (
                    <SelectItem key={item.value} value={item.value}>{resolveTriggerLabel(item)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 sm:col-span-2">
              <span className="text-sm">启用</span>
              <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="启用工作流" />
            </div>
          </div>

          <section className="space-y-2">
            <h3 className="text-sm font-medium">触发器配置</h3>
            <TriggerConfigFields triggerType={effectiveTrigger} metas={triggerMetas.items} value={triggerConfig} onChange={setTriggerConfig} />
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-medium">条件</h3>
            <ConditionEditor value={condition} onChange={setCondition} />
          </section>

          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">动作</h3>
              <span className="text-xs text-muted-foreground">
                {actionMetas.isLoading ? '加载动作声明…' : `共 ${actionsState.nodes.length} 个动作；顺序即执行顺序`}
              </span>
            </div>
            {actionMetas.error ? <p className="text-xs text-destructive">动作声明加载失败：{actionMetas.error}</p> : null}
            <ActionBuilder
              nodes={actionsState.nodes}
              metas={actionMetas.items}
              parseError={actionsState.error}
              onChange={(next) => setActionsDsl(JSON.stringify(next, null, 2))}
            />
          </section>

          <section className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="wf-actions">动作 DSL（JSON 数组）</Label>
              <Button variant="ghost" size="sm" onClick={() => setShowDsl(!showDsl)}>
                {showDsl ? '收起高级编辑' : '高级：直接编辑动作 DSL'}
              </Button>
            </div>
            {showDsl ? (
              <textarea
                id="wf-actions"
                className="min-h-40 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
                value={actionsDsl}
                onChange={(event) => setActionsDsl(event.target.value)}
              />
            ) : (
              <p className="text-xs text-muted-foreground">
                可视化编辑会实时写回这份 DSL；需要手写（例如 meta 里没有的动作）时展开。
              </p>
            )}
          </section>
        </div>
        </div>

        <DialogFooter className="border-t border-border bg-card px-6 py-4">
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" onClick={() => void submit()} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 空数组常量：`?? []` 每次渲染都是新引用，别让它进依赖 */
const EMPTY_PARAMS: WorkflowActionParam[] = [];

/** 触发器配置：后端带回 params 就按表单渲染，否则回退 JSON（当前后端没有 triggers 源，走的是后者） */
function TriggerConfigFields({ triggerType, metas, value, onChange }: {
  triggerType: string;
  metas: WorkflowActionMeta[];
  value: string;
  onChange: (next: string) => void;
}) {
  const item = metas.find((meta) => meta.value === triggerType);
  const params = item?.params ?? EMPTY_PARAMS;
  const parsed = useMemo(() => parseJsonObject(value), [value]);

  // params 为空（后端未声明）或 JSON 已写坏：都退回纯 JSON，避免"表单看着正常、其实保存了半截配置"
  if (params.length === 0 || !parsed) {
    return (
      <div className="space-y-1">
        <Label htmlFor="wf-config">触发器配置（JSON）</Label>
        <textarea
          id="wf-config"
          className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {params.length === 0
            ? '后端未声明该触发器的配置参数，按 JSON 填写。'
            : '当前内容不是合法 JSON 对象，先修正后才能用表单编辑。'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {params.map((param) => (
        <TriggerParamField
          key={param.key}
          param={param}
          config={parsed}
          onChange={(key, next) => {
            const out: Record<string, unknown> = { ...parsed };
            if (next === undefined) delete out[key];
            else out[key] = next;
            onChange(JSON.stringify(out, null, 2));
          }}
        />
      ))}
    </div>
  );
}

function TriggerParamField({ param, config, onChange }: {
  param: WorkflowActionParam;
  config: Record<string, unknown>;
  onChange: (key: string, next: unknown) => void;
}) {
  const id = useId();
  const label = resolveParamLabel(param);
  const raw = config[param.key];
  const text = raw === undefined || raw === null ? '' : String(raw);

  let control;
  if (param.type === 'multiselect') {
    // 数组型配置（recordTypes / statuses）：勾选框组，空数组表示「不加过滤」
    const selected = Array.isArray(raw) ? raw.map((item) => String(item)) : [];
    control = (
      <div className="flex flex-wrap gap-phi-4">
        {(param.options ?? []).map((option) => {
          const checked = selected.includes(option);
          return (
            <label key={option} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-input"
                checked={checked}
                onChange={() => {
                  const next = checked ? selected.filter((item) => item !== option) : [...selected, option];
                  onChange(param.key, next.length > 0 ? next : undefined);
                }}
              />
              {option}
            </label>
          );
        })}
      </div>
    );
  } else if (param.type === 'boolean') {
    control = (
      <div className="flex items-center gap-2">
        <Switch id={id} checked={raw === true} onCheckedChange={(checked) => onChange(param.key, checked)} />
        <span className="text-xs text-muted-foreground">{raw === true ? '是' : '否'}</span>
      </div>
    );
  } else if (param.options && param.options.length > 0) {
    control = (
      <Select value={text || undefined} onValueChange={(next) => onChange(param.key, next)}>
        <SelectTrigger id={id}><SelectValue placeholder={'选择' + label} /></SelectTrigger>
        <SelectContent>
          {param.options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
        </SelectContent>
      </Select>
    );
  } else {
    control = (
      <Input
        id={id}
        type={param.type === 'number' ? 'number' : 'text'}
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          onChange(param.key, next === '' ? undefined : param.type === 'number' ? Number(next) : next);
        }}
      />
    );
  }

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}{param.required ? <span className="text-destructive"> *</span> : null}</Label>
      {control}
    </div>
  );
}

/** 严格的对象解析：数组与标量都不算合法配置 */
function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = text.trim() ? JSON.parse(text) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function RunHistoryDialog({ workflow, onClose }: { workflow: WorkflowRow; onClose: () => void }) {
  const runs = useQuery({ queryKey: ['workflow-runs', workflow.id], queryFn: () => workflowsApi.runs(workflow.id) });

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="w-[min(96vw,44rem)]">
        <DialogHeader>
          <DialogTitle>运行记录 · {workflow.name}</DialogTitle>
          <DialogDescription>最近 50 次执行；失败原因显示在状态下方。</DialogDescription>
        </DialogHeader>
        {runs.isLoading ? <Skeleton className="h-24" /> : (runs.data ?? []).length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">还没有运行记录</p>
        ) : (
          <ul className="max-h-80 divide-y divide-border overflow-y-auto">
            {(runs.data ?? []).map((run: WorkflowRunRow) => {
              const status = runStatus(run.status);
              return (
                <li key={run.id} className="flex items-start gap-2 py-2 text-sm">
                  <Badge variant={status.variant}>{status.label}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs text-muted-foreground">{run.trace_id}</p>
                    {run.error && <p className="mt-0.5 text-xs text-destructive">{run.error}</p>}
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {run.started_at ? formatRelative(run.started_at) : '—'}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <DialogFooter>
          <Button size="sm" onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RunWorkflowDialog({ workflow, onClose, onDone, onError }: {
  workflow: WorkflowRow;
  onClose: () => void;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [domainName, setDomainName] = useState('');
  const [name, setName] = useState('www');
  const [type, setType] = useState('A');
  const [oldValue, setOldValue] = useState('');
  const [pending, setPending] = useState(false);

  // 换域名后清空「新值」：以域名作为归属判断，避免 effect 清空
  const [valueFor, setValueFor] = useState<{ domain: string; value: string }>({ domain: '', value: '' });
  const value = valueFor.domain === domainName ? valueFor.value : '';
  const setValue = (next: string) => setValueFor({ domain: domainName, value: next });

  const submit = async () => {
    if (!domainName.trim()) { onError('请输入域名'); return; }
    setPending(true);
    try {
      const result = await workflowsApi.run(workflow.id, {
        domainId: 0,
        domainName: domainName.trim(),
        record: { name, type, value: value || undefined, oldValue: oldValue || undefined },
      });
      onDone('已触发运行（' + result.status + '，trace ' + result.traceId + '）');
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : '运行失败');
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>手动运行 · {workflow.name}</DialogTitle>
          <DialogDescription>用一条模拟记录验证动作链路；会写入运行记录并消耗真实配额。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-phi-6 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="run-domain">域名</Label>
            <Input id="run-domain" value={domainName} onChange={(event) => setDomainName(event.target.value)} placeholder="example.com" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="run-name">主机记录</Label>
            <Input id="run-name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="run-type">记录类型</Label>
            <Input id="run-type" value={type} onChange={(event) => setType(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="run-value">新值</Label>
            <Input id="run-value" value={value} onChange={(event) => setValue(event.target.value)} placeholder="203.0.113.10" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="run-old-value">原值（可选）</Label>
            <Input id="run-old-value" value={oldValue} onChange={(event) => setOldValue(event.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" onClick={() => void submit()} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}运行
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}