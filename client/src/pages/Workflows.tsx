import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Dialog, Form, Input, InputNumber, Select, Switch, Space, Checkbox, Tag } from 'tdesign-react';
import { workflowsApi } from '../api';
import type { WorkflowRecord, WorkflowActionMeta, WorkflowRunRecord } from '../api';
import { Table } from '../components/Table';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CascadingSelect } from '../components/workflows/CascadingSelect';
import { SuggestInput } from '../components/workflows/SuggestInput';
import { useI18n } from '../contexts/I18nContext';
import { useFormSync } from '../hooks/useFormSync';
import { useToast } from '../hooks/useToast';
import {
  CONDITION_FIELDS,
  CONDITION_OPS,
  EMPTY_CONDITION,
  EMPTY_CONDITION_ROW,
  EMPTY_ROW,
  describeError,
  fromConditionNode,
  formatDuration,
  formatServerTime,
  findMissingRequiredArg,
  fromDslNodes,
  summarizeTriggerEvent,
  toConditionNode,
  toDslNodes,
  type ActionRow,
  type ConditionDraft,
} from '../utils/workflows';
import './Workflows.css';

/** 条件字段路径 → i18n key。界面上直接铺 event.record.value 对人不友好 */
/** 参数可以引用的上下文路径（与条件字段同一套，避免两处口径漂移） */
const EVENT_REF_PATHS = [
  'event.record.value',
  'event.record.oldValue',
  'event.record.name',
  'event.record.type',
  'event.domain.name',
  'event.status',
  'event.daysLeft',
];

const CONDITION_FIELD_LABEL_KEYS: Record<string, string> = {
  'event.record.value': 'workflows.fieldRecordValue',
  'event.record.oldValue': 'workflows.fieldOldValue',
  'event.record.name': 'workflows.fieldRecordName',
  'event.record.type': 'workflows.fieldRecordType',
  'event.domain.name': 'workflows.fieldDomainName',
  'event.status': 'workflows.fieldStatus',
  'event.daysLeft': 'workflows.fieldDaysLeft',
};

/** 运行状态 → TDesign Tag 主题 */
function runStatusTheme(status?: string): 'success' | 'danger' | 'default' | 'primary' {
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
      return 'danger';
    case 'skipped':
      return 'default';
    case 'running':
      return 'primary';
    default:
      return 'default';
  }
}

/** 动作风险等级 → TDesign Tag 主题（meta 里已有 risk，此前界面完全没用上） */
function riskTheme(risk?: string): 'success' | 'warning' | 'danger' | 'default' {
  switch (risk) {
    case 'low':
      return 'success';
    case 'medium':
      return 'warning';
    case 'high':
      return 'danger';
    default:
      return 'default';
  }
}

interface MetaItem {
  value: string;
  label?: string;
}

interface WorkflowForm {
  name: string;
  enabled: boolean;
  triggerType: string;
  recordTypes: string[];
  domainFields: string[];
  nsStatuses: string[];
  withinDays: string;
  rows: ActionRow[];
  condition: ConditionDraft;
}

const DEFAULT_FORM: WorkflowForm = {
  name: '',
  enabled: true,
  triggerType: 'record.changed',
  recordTypes: ['A', 'AAAA'],
  domainFields: [],
  nsStatuses: [],
  withinDays: '',
  rows: [{ ...EMPTY_ROW }],
  condition: { ...EMPTY_CONDITION },
};

const FORM_FIELDS: Array<keyof WorkflowForm> = [
  'name', 'enabled', 'triggerType', 'recordTypes', 'domainFields', 'nsStatuses', 'withinDays', 'rows', 'condition',
];

function toFormState(record: WorkflowRecord): Partial<WorkflowForm> {
  const config = (record.triggerConfig ?? {}) as Record<string, unknown>;
  return {
    name: record.name,
    enabled: record.enabled,
    triggerType: record.triggerType,
    recordTypes: (config.recordTypes as string[]) ?? ['A', 'AAAA'],
    domainFields: (config.fields as string[]) ?? [],
    nsStatuses: (config.statuses as string[]) ?? [],
    withinDays: typeof config.withinDays === 'number' ? String(config.withinDays) : '',
    rows: fromDslNodes(record.actions),
    condition: fromConditionNode(record.condition),
  };
}

export function Workflows() {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  // DSL 预览默认收起，避免机器标识符默认出现在界面上
  const [showDsl, setShowDsl] = useState(false);
  const [editing, setEditing] = useState<WorkflowRecord | null>(null);
  // 每次打开对话框都递增：保证 initial 是新对象，useFormSync 才会重新回填/重置
  const [formKey, setFormKey] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<WorkflowRecord | null>(null);
  const [runsFor, setRunsFor] = useState<WorkflowRecord | null>(null);
  const [previewFor, setPreviewFor] = useState<WorkflowRecord | null>(null);
  const [runFor, setRunFor] = useState<WorkflowRecord | null>(null);
  const [runDomain, setRunDomain] = useState('');
  const [runDomainId, setRunDomainId] = useState(0);
  const [runName, setRunName] = useState('www');
  const [runType, setRunType] = useState('A');
  const [runValue, setRunValue] = useState('');
  const [runOldValue, setRunOldValue] = useState('');

  const initial = useMemo(() => (editing ? toFormState(editing) : null), [editing, formKey]);
  const { formState, updateField, resetForm } = useFormSync<WorkflowForm>(initial as WorkflowForm | null, DEFAULT_FORM, {
    fields: FORM_FIELDS,
  });

  const form = { ...DEFAULT_FORM, ...formState } as WorkflowForm;

  const listQuery = useQuery({ queryKey: ['workflows'], queryFn: () => workflowsApi.list() });
  const actionsQuery = useQuery({ queryKey: ['workflow-actions'], queryFn: () => workflowsApi.meta<WorkflowActionMeta[]>('actions') });
  const triggerQuery = useQuery({ queryKey: ['workflow-triggers'], queryFn: () => workflowsApi.meta('triggerTypes') });
  const recordTypesQuery = useQuery({ queryKey: ['workflow-meta', 'recordTypes'], queryFn: () => workflowsApi.meta<MetaItem[]>('recordTypes') });
  const domainFieldsQuery = useQuery({ queryKey: ['workflow-meta', 'domainFields'], queryFn: () => workflowsApi.meta<MetaItem[]>('domainFields') });
  const nsStatusesQuery = useQuery({ queryKey: ['workflow-meta', 'nsStatuses'], queryFn: () => workflowsApi.meta<MetaItem[]>('nsStatuses') });
  const allowlistQuery = useQuery({
    queryKey: ['workflow-meta', 'outboundAllowlist'],
    queryFn: () => workflowsApi.meta<string[]>('outboundAllowlist'),
  });
  const domainOptionsQuery = useQuery({
    queryKey: ['workflow-meta', 'domains'],
    queryFn: () => workflowsApi.meta<Array<{ value: string; label: string; id: number }>>('domains'),
    enabled: Boolean(runFor),
  });
  const runsQuery = useQuery({
    queryKey: ['workflow-runs', runsFor?.id],
    queryFn: () => workflowsApi.runs(runsFor!.id),
    enabled: Boolean(runsFor),
  });
  const sampleQuery = useQuery({
    queryKey: ['workflow-sample', previewFor?.id],
    queryFn: () => workflowsApi.sampleEvent(previewFor!.id),
    enabled: Boolean(previewFor),
  });

  const items = (listQuery.data?.data?.data as { items?: WorkflowRecord[] } | undefined)?.items ?? [];
  const actions = (actionsQuery.data?.data?.data as { items?: WorkflowActionMeta[] } | undefined)?.items ?? [];
  const triggers = (triggerQuery.data?.data?.data as { items?: Array<{ value: string; label: string }> } | undefined)?.items ?? [];
  // meta 返回的是 { value, label } 对象数组，不是字符串数组
  // axios → AxiosResponse.data → ApiResponse.data → { items }
  // label 是 i18n key，渲染时再翻译；丢了 label 就只能把 value（机器标识符）显示给人看
  const metaItems = (
    source: { data?: { data?: { data?: { items?: Array<{ value?: string; label?: string }> } } } } | undefined,
  ): Array<{ value: string; label: string }> =>
    (source?.data?.data?.data?.items ?? [])
      .map((item) => ({ value: String(item.value ?? ''), label: String(item.label ?? item.value ?? '') }))
      .filter((item) => item.value);
  const recordTypes = metaItems(recordTypesQuery);
  const domainFields = metaItems(domainFieldsQuery);
  const nsStatuses = metaItems(nsStatusesQuery);
  const domainOptions = (domainOptionsQuery.data?.data?.data as { items?: Array<{ value: string; label: string; id: number }> } | undefined)?.items ?? [];
  const runs = (runsQuery.data?.data?.data as { runs?: WorkflowRunRecord[] } | undefined)?.runs ?? [];
  const allowlist = (allowlistQuery.data?.data?.data as { items?: string[] } | undefined)?.items ?? [];

  const actionMap = useMemo(() => new Map(actions.map((item) => [item.value, item])), [actions]);
  // 列表里的触发器列原来直接打印 row.triggerType（record.changed），这里换成可读名称
  const triggerLabels = useMemo(() => new Map(triggers.map((item) => [item.value, item.label])), [triggers]);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['workflows'] });

  /**
   * 保存前先在本地校验必填参数。
   * 否则留空的必填项会被 toDslNodes 静默丢弃，工作流能保存成功、直到运行时才报参数缺失——
   * 那时用户已经离开了编辑界面，很难把错误对回是哪一步。
   */
  const validateRows = (): string | null => {
    // 不强制「至少一个动作」：既有用例与产品行为允许先存空壳再补动作，这里只管住必填项被静默丢弃
    const missing = findMissingRequiredArg(form.rows, (action) => actionMap.get(action));
    if (!missing) return null;
    const item = actionMap.get(missing.action);
    const param = item?.params?.find((p) => p.key === missing.param);
    return t('workflows.missingRequired', {
      action: item ? t(item.label) : missing.action,
      param: t(param?.label || missing.param),
    });
  };

  const handleSave = () => {
    const message = validateRows();
    if (message) {
      toast.error(message);
      return;
    }
    saveMutation.mutate();
  };

  /** 保存与 DSL 预览共用同一份构造逻辑，避免两处漂移 */
  const buildPayload = () => ({
    name: form.name,
    enabled: form.enabled,
    triggerType: form.triggerType,
    triggerConfig:
      form.triggerType === 'record.changed'
        ? { recordTypes: form.recordTypes }
        : form.triggerType === 'domain.changed'
          ? { fields: form.domainFields }
          : form.triggerType === 'ns.changed'
            ? { statuses: form.nsStatuses }
            : form.triggerType === 'whois.expiring'
              ? form.withinDays === '' ? {} : { withinDays: Number(form.withinDays) }
              : {},
    // 关闭条件时发 null：undefined 会被 JSON.stringify 丢弃，服务端会保留旧条件
    condition: toConditionNode(form.condition) ?? null,
    actions: toDslNodes(form.rows),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = buildPayload();
      return editing ? workflowsApi.update(editing.id, payload) : workflowsApi.create(payload);
    },
    onSuccess: () => {
      toast.success(t('workflows.saved'));
      setDialogOpen(false);
      invalidate();
    },
    onError: (error: unknown) => toast.error(describeError(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => workflowsApi.remove(id),
    onSuccess: () => { setPendingDelete(null); invalidate(); },
    onError: (error: unknown) => { setPendingDelete(null); toast.error(describeError(error)); },
  });

  const runMutation = useMutation({
    mutationFn: () =>
      workflowsApi.run(runFor!.id, {
        domainId: runDomainId,
        domainName: runDomain,
        record: { name: runName, type: runType, value: runValue, oldValue: runOldValue || undefined },
      }),
    onSuccess: (response) => {
      const result = (response.data?.data ?? {}) as { status?: string; error?: string };
      if (result.status === 'failed') {
        toast.error(result.error ?? t('workflows.runFailed'));
        return;
      }
      if (result.status === 'skipped') {
        toast.info(t('workflows.runSkipped'));
        return;
      }
      toast.success(t('workflows.runTriggered'));
      setRunFor(null);
    },
    onError: (error: unknown) => toast.error(describeError(error)),
  });

  function openCreate() {
    setEditing(null);
    // initial 为 null 时引用不变，useFormSync 的 effect 不会重跑，必须显式重置
    resetForm();
    setFormKey((value) => value + 1);
    setShowDsl(false);
    setDialogOpen(true);
  }

  function openEdit(record: WorkflowRecord) {
    setEditing(record);
    setFormKey((value) => value + 1);
    setShowDsl(false);
    setDialogOpen(true);
  }

  const columns = [
    {
      key: 'name',
      label: t('workflows.name'),
      width: 240,
      render: (row: WorkflowRecord) =>
        row.corrupted ? (
          <Space size="small">
            <Tag theme="danger" variant="light">{t('workflows.corrupted')}</Tag>
            <span>{row.name}</span>
          </Space>
        ) : (
          row.name
        ),
    },
    { key: 'triggerType', label: t('workflows.trigger'), width: 180, render: (row: WorkflowRecord) => t(triggerLabels.get(row.triggerType) ?? row.triggerType) },
    {
      key: 'actions',
      label: t('workflows.actions'),
      width: 260,
      // 只给个数字看不出这条工作流到底干什么，这里直接列出动作链路（机器名回落到原始值，不隐藏异常）
      render: (row: WorkflowRecord) => {
        const list = (row.actions ?? []) as Array<{ action?: string }>;
        if (list.length === 0) return '-';
        return list
          .map((node) => {
            const name = String(node.action ?? '');
            const item = actionMap.get(name);
            return item ? t(item.label) : name || '?';
          })
          .join(' → ');
      },
    },
    { key: 'enabled', label: t('workflows.enabled'), width: 100, render: (row: WorkflowRecord) => (row.enabled ? t('common.enabled') : t('common.disabled')) },
    {
      key: 'op',
      label: t('workflows.operations'),
      render: (row: WorkflowRecord) => (
        <Space>
          {!row.corrupted && (
            <Button size="small" variant="text" onClick={() => openEdit(row)}>{t('common.edit')}</Button>
          )}
          {!row.corrupted && (
            <>
              <Button size="small" variant="text" onClick={() => setRunsFor(row)}>{t('workflows.runs')}</Button>
              <Button size="small" variant="text" onClick={() => setPreviewFor(row)}>{t('workflows.preview')}</Button>
              <Button size="small" variant="text" onClick={() => { setRunFor(row); setRunDomain(''); setRunDomainId(0); setRunValue(''); setRunOldValue(''); }}>{t('workflows.run')}</Button>
            </>
          )}
          <Button size="small" variant="text" theme="danger" onClick={() => setPendingDelete(row)}>{t('common.delete')}</Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="workflows-page">
      <div className="workflows-header">
        <h2>{t('workflows.title')}</h2>
        <Space>
          <Button variant="outline" onClick={() => listQuery.refetch()}>{t('common.refresh')}</Button>
          <Button theme="primary" onClick={openCreate}>{t('workflows.create')}</Button>
        </Space>
      </div>

      {allowlistQuery.isSuccess && allowlist.length === 0 && (
        <div className="workflows-error">
          {t('workflows.emptyAllowlist')}
        </div>
      )}
      {allowlistQuery.isSuccess && allowlist.length > 0 && (
        <div className="workflows-hint">
          {t('workflows.allowlistSummary')}: {allowlist.join(', ')}
        </div>
      )}

      {listQuery.isError && (
        <div className="workflows-error">
          {describeError(listQuery.error)}
          <Button size="small" variant="text" onClick={() => listQuery.refetch()}>{t('common.retry')}</Button>
        </div>
      )}

      <Table
        rowKey={(row: WorkflowRecord) => row.id}
        data={items}
        columns={columns}
        loading={listQuery.isLoading}
        emptyText={t('workflows.empty')}
      />

      <Dialog
        dialogClassName="app-td-dialog"
        visible={dialogOpen}
        onClose={() => setDialogOpen(false)}
        header={editing ? t('workflows.edit') : t('workflows.create')}
        width="760px"
        footer={(
          <Space>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button theme="primary" loading={saveMutation.isPending} onClick={handleSave}>{t('common.save')}</Button>
          </Space>
        )}
      >
        <Form labelWidth="120px">
          <Form.FormItem label={t('workflows.name')}>
            <Input value={form.name} onChange={(value) => updateField('name', String(value))} />
          </Form.FormItem>
          <Form.FormItem label={t('workflows.enabled')}>
            <Switch value={form.enabled} onChange={(value) => updateField('enabled', Boolean(value))} />
          </Form.FormItem>
          <Form.FormItem label={t('workflows.trigger')}>
            <Select
              value={form.triggerType}
              onChange={(value) => updateField('triggerType', String(value))}
              options={triggers.map((item) => ({ label: t(item.label || item.value), value: item.value }))}
            />
          </Form.FormItem>
          {form.triggerType === 'record.changed' && (
            <Form.FormItem label={t('workflows.recordTypes')}>
              <Checkbox.Group value={form.recordTypes} onChange={(value) => updateField('recordTypes', value as string[])}>
                {(recordTypes.length ? recordTypes : [{ value: 'A', label: 'A' }, { value: 'AAAA', label: 'AAAA' }]).map((item) => (
                  <Checkbox key={item.value} value={item.value}>{t(item.label)}</Checkbox>
                ))}
              </Checkbox.Group>
            </Form.FormItem>
          )}
          {form.triggerType === 'domain.changed' && (
            <Form.FormItem label={t('workflows.fields')}>
              <Checkbox.Group value={form.domainFields} onChange={(value) => updateField('domainFields', value as string[])}>
                {domainFields.map((item) => (
                  <Checkbox key={item.value} value={item.value}>{t(item.label)}</Checkbox>
                ))}
              </Checkbox.Group>
            </Form.FormItem>
          )}
          {form.triggerType === 'ns.changed' && (
            <Form.FormItem label={t('workflows.nsStatuses')}>
              <Checkbox.Group value={form.nsStatuses} onChange={(value) => updateField('nsStatuses', value as string[])}>
                {nsStatuses.map((item) => (
                  <Checkbox key={item.value} value={item.value}>{t(item.label)}</Checkbox>
                ))}
              </Checkbox.Group>
            </Form.FormItem>
          )}
          {form.triggerType === 'whois.expiring' && (
            <Form.FormItem label={t('workflows.withinDays')}>
              <Input type="number" value={form.withinDays} onChange={(value) => updateField('withinDays', String(value))} />
            </Form.FormItem>
          )}

          <Form.FormItem label={t('workflows.condition')}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Switch
                value={form.condition.enabled}
                onChange={(value) => updateField('condition', { ...form.condition, enabled: Boolean(value) })}
              />
              {form.condition.enabled && form.condition.raw && (
                <div className="workflow-condition-advanced">
                  {/* 表单表达不了的条件（logic 里混了算术/三元等）原样保留，只给出人能看的形态 */}
                  {t('workflows.advancedCondition')}: {t(`workflows.condKind_${form.condition.raw.kind}`)}
                </div>
              )}
              {form.condition.enabled && !form.condition.raw && (
                <Space direction="vertical" style={{ width: '100%' }}>
                  {/* 多条条件才需要连接方式；一条时显示反而让人以为有别的含义 */}
                  {form.condition.rows.length > 1 && (
                    <Select
                      value={form.condition.join}
                      style={{ width: 120 }}
                      options={[
                        { label: t('workflows.joinAnd'), value: 'and' },
                        { label: t('workflows.joinOr'), value: 'or' },
                      ]}
                      onChange={(value) => updateField('condition', { ...form.condition, join: String(value) as 'and' | 'or' })}
                    />
                  )}
                  <Checkbox
                    checked={form.condition.negate}
                    onChange={(value) => updateField('condition', { ...form.condition, negate: Boolean(value) })}
                  >
                    {t('workflows.negateCondition')}
                  </Checkbox>
                  {form.condition.rows.map((conditionRow, index) => {
                    const patchRow = (next: Partial<typeof conditionRow>) => {
                      const rows = form.condition.rows.map((item, i) => (i === index ? { ...item, ...next } : item));
                      updateField('condition', { ...form.condition, rows });
                    };
                    return (
                      <div className="workflow-condition-row" key={index}>
                        <Select
                          value={conditionRow.field}
                          options={CONDITION_FIELDS.map((field) => ({ label: t(CONDITION_FIELD_LABEL_KEYS[field.path] ?? field.path), value: field.path }))}
                          onChange={(value) => patchRow({ field: String(value) })}
                        />
                        <Select
                          value={conditionRow.op}
                          options={CONDITION_OPS.map((op) => ({ label: op, value: op }))}
                          onChange={(value) => patchRow({ op: String(value) })}
                        />
                        <Input
                          value={conditionRow.value}
                          placeholder={conditionRow.op === 'in' ? t('workflows.inHint') : t('workflows.conditionValue')}
                          onChange={(value) => patchRow({ value: String(value) })}
                        />
                        {form.condition.rows.length > 1 && (
                          <Button
                            size="small"
                            variant="text"
                            theme="danger"
                            onClick={() => updateField('condition', { ...form.condition, rows: form.condition.rows.filter((_, i) => i !== index) })}
                          >
                            {t('common.delete')}
                          </Button>
                        )}
                      </div>
                    );
                  })}
                  <Button
                    size="small"
                    variant="outline"
                    onClick={() => updateField('condition', { ...form.condition, rows: [...form.condition.rows, { ...EMPTY_CONDITION_ROW }] })}
                  >
                    {t('workflows.addCondition')}
                  </Button>
                </Space>
              )}
            </Space>
          </Form.FormItem>

          <Form.FormItem label={t('workflows.actions')}>
            <Space direction="vertical" style={{ width: '100%' }}>
              {form.rows.map((row, index) => {
                const meta = actionMap.get(row.action);
                const patch = (next: ActionRow) => {
                  const rows = [...form.rows];
                  rows[index] = next;
                  updateField('rows', rows);
                };
                return (
                  <div className="workflow-action-row" key={index}>
                    <Select
                      value={row.action}
                      placeholder={t('workflows.pickAction')}
                      options={actions
                        .filter((item) => item.dslVisible)
                        .map((item) => ({ label: t(item.label || item.value), value: item.value }))}
                      onChange={(value) => patch({ action: String(value), args: {} })}
                    />
                    <div className="workflow-params">
                      {meta?.params?.map((param) => {
                        // 参数键是机器标识符（domainId / diffDigest），不能直接给人看
                        const label = t(param.label || param.key);
                        const paramLabels = Object.fromEntries(
                          (meta?.params ?? []).map((item) => [item.key, t(item.label || item.key)]),
                        );
                        const arg = row.args[param.key];
                        const argValue = arg?.value ?? '';
                        // 分开两个 setter：TDesign 的 onChange 第二参是 context，
                        // 给 setArg 加「类型」参数会与控件签名冲突（tsc -b 会报 TS2322）。
                        const setArg = (value: unknown) =>
                          patch({ ...row, args: { ...row.args, [param.key]: { kind: 'literal', value: String(value) } } });
                        const setArgRef = (path: unknown) =>
                          patch({ ...row, args: { ...row.args, [param.key]: { kind: 'ref', value: String(path) } } });
                        // 控件要按参数类型给：布尔给开关、数字给数字框，
                        // 否则用户得在文本框里手打 "true" / "1"，既不好读也容易写错。
                        const control = param.source ? (
                          <CascadingSelect
                            param={param}
                            labels={paramLabels}
                            args={row.args}
                            value={argValue}
                            onChange={setArg}
                          />
                        ) : param.type === 'boolean' ? (
                          <Switch
                            value={argValue === 'true'}
                            onChange={(value: any) => setArg(Boolean(value))}
                          />
                        ) : param.type === 'number' ? (
                          <InputNumber
                            placeholder={label}
                            value={argValue === '' ? undefined : Number(argValue)}
                            onChange={setArg}
                            style={{ width: '100%' }}
                          />
                        ) : param.type === 'select' && param.options?.length ? (
                          <Select
                            placeholder={label}
                            value={argValue}
                            options={param.options.map((option) => ({ label: option, value: option }))}
                            onChange={setArg}
                          />
                        ) : param.suggestSource ? (
                          // 可自由输入 + 候选建议：域名这类参数常见值有限，但不该限制用户只能选
                          <SuggestInput
                            source={param.suggestSource}
                            value={argValue}
                            placeholder={label}
                            onChange={setArg}
                          />
                        ) : arg?.kind === 'ref' ? (
                          // 引用事件字段：值要到运行时才有，界面上只展示引用了什么
                          <Space size="small">
                            <Tag theme="primary" variant="light">{t(CONDITION_FIELD_LABEL_KEYS[argValue] ?? argValue)}</Tag>
                            <Button size="small" variant="text" onClick={() => setArg('')}>
                              {t('workflows.clearRef')}
                            </Button>
                          </Space>
                        ) : (
                          <Space size="small">
                            <Input placeholder={label} value={argValue} onChange={setArg} />
                            <Select
                              size="small"
                              placeholder={t('workflows.useEventValue')}
                              options={EVENT_REF_PATHS.map((path) => ({
                                label: t(CONDITION_FIELD_LABEL_KEYS[path] ?? path),
                                value: path,
                              }))}
                              onChange={(value: any) => setArgRef(value)}
                              style={{ minWidth: 160 }}
                            />
                          </Space>
                        );
                        return (
                          <label className="workflow-param" key={param.key}>
                            {/* 必填项要能一眼看出来：留空会在保存时被拦下，与其等报错不如先标出来 */}
                            <span className="workflow-param__label">
                              {label}
                              {param.required ? <span className="workflow-param__required" title={t('common.required')}>*</span> : null}
                            </span>
                            {control}
                          </label>
                        );
                      })}
                      {meta ? (
                        // 光有动作名不够：用户需要知道这一步到底会做什么，尤其是 plan/replace 这种成对的。
                        // 同时给出机器名与风险等级——机器名用于对日志和审计，风险等级用于判断要不要写进生产工作流。
                        <>
                          {meta.description ? <p className="workflow-action-desc">{t(meta.description)}</p> : null}
                          {/* 机器名只放在 title 里：界面上不出现标识符（既有用例明确约束），
                              但要能对日志与审计时悬停查到。 */}
                          <p className="workflow-action-meta" title={meta.value}>
                            <Tag size="small" variant="light" theme={riskTheme(meta.risk)}>
                              {t(`workflows.risk_${meta.risk}`)}
                            </Tag>
                          </p>
                        </>
                      ) : null}
                    </div>
                    <Button size="small" variant="text" theme="danger" onClick={() => updateField('rows', form.rows.filter((_, i) => i !== index))}>
                      {t('common.delete')}
                    </Button>
                  </div>
                );
              })}
              <Button size="small" variant="outline" onClick={() => updateField('rows', [...form.rows, { ...EMPTY_ROW }])}>
                {t('workflows.addAction')}
              </Button>
            </Space>
          </Form.FormItem>

          {/* DSL 预览默认收起：界面上不出现机器标识符是既有约束，需要时再展开 */}
          <Form.FormItem label={t('workflows.dslPreview')}>
            <Button size="small" variant="text" onClick={() => setShowDsl((prev) => !prev)}>
              {showDsl ? t('workflows.dslHide') : t('workflows.dslShow')}
            </Button>
            {showDsl && <pre className="workflow-dsl-preview">{JSON.stringify(buildPayload(), null, 2)}</pre>}
          </Form.FormItem>
        </Form>
      </Dialog>

      <Dialog
        dialogClassName="app-td-dialog"
        visible={Boolean(runsFor)}
        onClose={() => setRunsFor(null)}
        header={t('workflows.runs')}
        width="720px"
        footer={<Button variant="outline" onClick={() => setRunsFor(null)}>{t('common.close')}</Button>}
      >
        <Table
          rowKey={(row: WorkflowRunRecord) => row.id}
          data={runs}
          loading={runsQuery.isLoading}
          columns={[
            {
              key: 'status',
              label: t('workflows.colStatus'),
              width: 100,
              // 服务端存的是 success / failed / skipped，直接显示原文对人没意义
              render: (row: WorkflowRunRecord) => (
                <Tag size="small" variant="light" theme={runStatusTheme(row.status)}>
                  {t(`workflows.runStatus_${row.status}`)}
                </Tag>
              ),
            },
            {
              key: 'started_at',
              label: t('workflows.colStarted'),
              width: 180,
              render: (row: WorkflowRunRecord) => formatServerTime(row.started_at),
            },
            {
              key: 'duration',
              label: t('workflows.colDuration'),
              width: 90,
              // 耗时是判断「这次为什么超时/变慢」的第一手信息，此前完全没有
              render: (row: WorkflowRunRecord) => formatDuration(row.started_at, row.finished_at),
            },
            {
              key: 'trigger_event',
              label: t('workflows.colTriggerEvent'),
              // 触发事件决定了这条运行为什么发生；存的是 JSON，直接铺原文没法读
              render: (row: WorkflowRunRecord) => summarizeTriggerEvent(row.trigger_event, (type) => t(triggerLabels.get(type) ?? type)),
            },
            { key: 'trace_id', label: t('workflows.colTrace'), width: 200 },
            {
              key: 'error',
              label: t('workflows.colError'),
              render: (row: WorkflowRunRecord) => (row.error ? <span className="workflow-run-error">{row.error}</span> : '-'),
            },
          ]}
        />
      </Dialog>

      <Dialog
        dialogClassName="app-td-dialog"
        visible={Boolean(previewFor)}
        onClose={() => setPreviewFor(null)}
        header={t('workflows.preview')}
        width="560px"
        footer={<Button variant="outline" onClick={() => setPreviewFor(null)}>{t('common.close')}</Button>}
      >
        {(() => {
          const event = (sampleQuery.data?.data?.data as { event?: Record<string, unknown> | null } | undefined)?.event ?? null;
          if (!event) return <div>{t('workflows.waitingForEvent')}</div>;
          const domain = (event.domain ?? {}) as { name?: string };
          const record = (event.record ?? {}) as { name?: string; type?: string; value?: string; oldValue?: string };
          return (
            <div className="workflow-preview">
              {/* 这里原来写死英文键名（type / oldValue），和其它页面的本地化不一致 */}
              <div><strong>{t('workflows.previewType')}</strong>: {t(triggerLabels.get(String(event.type ?? '')) ?? String(event.type ?? ''))}</div>
              <div><strong>{t('workflows.previewDomain')}</strong>: {domain.name ?? '-'}</div>
              <div><strong>{t('workflows.previewRecord')}</strong>: {record.name ?? '-'} {record.type ?? ''}</div>
              <div><strong>{t('workflows.previewValue')}</strong>: {record.value ?? '-'}</div>
              <div><strong>{t('workflows.previewOldValue')}</strong>: {record.oldValue ?? '-'}</div>
            </div>
          );
        })()}
      </Dialog>

      <Dialog
        dialogClassName="app-td-dialog"
        visible={Boolean(runFor)}
        onClose={() => setRunFor(null)}
        header={t('workflows.run')}
        width="520px"
        footer={(
          <Space>
            <Button variant="outline" onClick={() => setRunFor(null)}>{t('common.cancel')}</Button>
            <Button theme="primary" loading={runMutation.isPending} onClick={() => runMutation.mutate()}>{t('workflows.run')}</Button>
          </Space>
        )}
      >
        <Form labelWidth="120px">
          <Form.FormItem label={t('workflows.runDomain')}>
            <Select
              value={runDomain}
              placeholder={t('workflows.pickDomain')}
              loading={domainOptionsQuery.isLoading}
              options={domainOptions.map((item) => ({ label: `${item.label} (#${item.id})`, value: item.value }))}
              onChange={(value) => {
                const picked = domainOptions.find((item) => item.value === String(value));
                setRunDomain(String(value));
                setRunDomainId(picked?.id ?? 0);
              }}
            />
          </Form.FormItem>
          <Form.FormItem label={t('workflows.runRecordName')}>
            <Input value={runName} onChange={(value) => setRunName(String(value))} />
          </Form.FormItem>
          <Form.FormItem label={t('workflows.runRecordType')}>
            <Select
              value={runType}
              options={(recordTypes.length ? recordTypes : [{ value: 'A', label: 'A' }, { value: 'AAAA', label: 'AAAA' }]).map(
                (item) => ({ label: t(item.label), value: item.value }),
              )}
              onChange={(value) => setRunType(String(value))}
            />
          </Form.FormItem>
          <Form.FormItem label={t('workflows.runRecordValue')}>
            <Input value={runValue} onChange={(value) => setRunValue(String(value))} />
          </Form.FormItem>
          <Form.FormItem label={t('workflows.runRecordOldValue')}>
            <Input value={runOldValue} onChange={(value) => setRunOldValue(String(value))} />
          </Form.FormItem>
        </Form>
      </Dialog>

      {pendingDelete && (
        <ConfirmDialog
          message={t('workflows.confirmDelete')}
          isLoading={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(pendingDelete.id)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}