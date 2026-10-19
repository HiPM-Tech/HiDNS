import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Dialog,
  Form,
  Input,
  Select,
  Switch,
  Table,
  Tag,
  Space,
  Checkbox,
  MessagePlugin,
} from 'tdesign-react';
import { workflowsApi } from '../api';
import type { WorkflowRecord, WorkflowDslNode, WorkflowActionMeta, WorkflowRunRecord } from '../api';
import { useI18n } from '../contexts/I18nContext';
import './Workflows.css';

interface ActionRow {
  action: string;
  args: Record<string, string>;
}

interface ConditionDraft {
  enabled: boolean;
  field: string;
  op: string;
  value: string;
}

/** 级联下拉：按参数声明的 source 拉取候选（如 originGroups 依赖 domainId） */
function CascadingSelect({
  param,
  args,
  value,
  onChange,
}: {
  param: { key: string; source?: string; sourceParams?: string[] };
  args: Record<string, string>;
  value: string;
  onChange: (value: string) => void;
}) {
  const params = useMemo(() => {
    const out: Record<string, string> = {};
    for (const key of param.sourceParams ?? []) {
      const raw = args[key];
      if (raw) out[key] = raw;
    }
    return out;
  }, [args, param.sourceParams]);

  const ready = (param.sourceParams ?? []).every((key) => Boolean(args[key]));
  const query = useQuery({
    queryKey: ['workflow-meta', param.source, params],
    queryFn: () => workflowsApi.meta<Array<{ value: string; label: string }>>(param.source!, params),
    enabled: Boolean(param.source) && ready,
  });

  const options = (query.data?.data?.data as { items?: Array<{ value: string; label: string }> } | undefined)?.items ?? [];

  return (
    <Select
      placeholder={ready ? param.key : `${param.key}（需先填 ${(param.sourceParams ?? []).join(', ')}）`}
      disabled={!ready}
      loading={query.isLoading}
      value={value}
      options={options.map((item) => ({ label: item.label, value: item.value }))}
      onChange={(next) => onChange(String(next))}
    />
  );
}

const CONDITION_FIELDS = [
  'event.record.value',
  'event.record.oldValue',
  'event.record.name',
  'event.record.type',
  'event.domain.name',
  'event.status',
  'event.daysLeft',
];

const CONDITION_OPS = ['==', '!=', '>', '>=', '<', '<=', 'in'];

function toConditionNode(draft: ConditionDraft): WorkflowDslNode | undefined {
  if (!draft.enabled || !draft.field) return undefined;
  const right: WorkflowDslNode = { kind: 'literal', value: draft.value };
  return {
    kind: 'compare',
    op: draft.op,
    left: { kind: 'ref', path: draft.field },
    right,
  };
}

function fromConditionNode(node: WorkflowDslNode | undefined): ConditionDraft {
  const empty: ConditionDraft = { enabled: false, field: CONDITION_FIELDS[0], op: '==', value: '' };
  if (!node || node.kind !== 'compare') return empty;
  const left = (node.left ?? {}) as { path?: string };
  const right = (node.right ?? {}) as { value?: unknown };
  return {
    enabled: true,
    field: left.path ?? CONDITION_FIELDS[0],
    op: String(node.op ?? '=='),
    value: String(right.value ?? ''),
  };
}

const EMPTY_ROW: ActionRow = { action: '', args: {} };

function toDslNodes(rows: ActionRow[]): WorkflowDslNode[] {
  return rows
    .filter((row) => row.action)
    .map((row) => {
      const args: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row.args)) {
        if (value === '') continue;
        args[key] = { kind: 'literal', value };
      }
      return { kind: 'call', action: row.action, args };
    });
}

function fromDslNodes(nodes: WorkflowDslNode[] | undefined): ActionRow[] {
  if (!Array.isArray(nodes) || nodes.length === 0) return [{ ...EMPTY_ROW }];
  return nodes.map((node) => {
    const args: Record<string, string> = {};
    const rawArgs = (node.args ?? {}) as Record<string, { value?: unknown }>;
    for (const [key, value] of Object.entries(rawArgs)) {
      args[key] = value && typeof value === 'object' && 'value' in value ? String(value.value ?? '') : '';
    }
    return { action: String(node.action ?? ''), args };
  });
}

export function Workflows() {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState<WorkflowRecord | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [runsFor, setRunsFor] = useState<WorkflowRecord | null>(null);
  const [runFor, setRunFor] = useState<WorkflowRecord | null>(null);
  const [previewFor, setPreviewFor] = useState<WorkflowRecord | null>(null);

  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [triggerType, setTriggerType] = useState('record.changed');
  const [recordTypes, setRecordTypes] = useState<string[]>(['A', 'AAAA']);
  const [domainFields, setDomainFields] = useState<string[]>([]);
  const [nsStatuses, setNsStatuses] = useState<string[]>([]);
  const [withinDays, setWithinDays] = useState<string>('');
  const [rows, setRows] = useState<ActionRow[]>([{ ...EMPTY_ROW }]);
  const [condition, setCondition] = useState<ConditionDraft>({ enabled: false, field: CONDITION_FIELDS[0], op: '==', value: '' });

  const [runDomain, setRunDomain] = useState('');
  const [runDomainId, setRunDomainId] = useState<number>(0);
  const [runName, setRunName] = useState('www');
  const [runValue, setRunValue] = useState('');

  const listQuery = useQuery({ queryKey: ['workflows'], queryFn: () => workflowsApi.list() });
  const actionsQuery = useQuery({ queryKey: ['workflow-actions'], queryFn: () => workflowsApi.meta<WorkflowActionMeta[]>('actions') });
  const triggerQuery = useQuery({ queryKey: ['workflow-triggers'], queryFn: () => workflowsApi.meta('triggerTypes') });
  const domainOptionsQuery = useQuery({
    queryKey: ['workflow-meta', 'domains'],
    queryFn: () => workflowsApi.meta<Array<{ value: string; label: string; id: number }>>('domains'),
    enabled: Boolean(runFor),
  });
  const sampleQuery = useQuery({
    queryKey: ['workflow-sample', previewFor?.id],
    queryFn: () => workflowsApi.sampleEvent(previewFor!.id),
    enabled: Boolean(previewFor),
  });
  const runsQuery = useQuery({
    queryKey: ['workflow-runs', runsFor?.id],
    queryFn: () => workflowsApi.runs(runsFor!.id),
    enabled: Boolean(runsFor),
  });

  const items = (listQuery.data?.data?.data as { items?: WorkflowRecord[] } | undefined)?.items ?? [];
  const actions = (actionsQuery.data?.data?.data as { items?: WorkflowActionMeta[] } | undefined)?.items ?? [];
  const triggers = (triggerQuery.data?.data?.data as { items?: Array<{ value: string; label: string }> } | undefined)?.items ?? [];
  const runs = (runsQuery.data?.data?.data as { runs?: WorkflowRunRecord[] } | undefined)?.runs ?? [];

  const actionMap = useMemo(() => new Map(actions.map((item) => [item.value, item])), [actions]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['workflows'] });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name,
        enabled,
        triggerType,
        triggerConfig:
          triggerType === 'record.changed'
            ? { recordTypes }
            : triggerType === 'domain.changed'
              ? { fields: domainFields }
              : triggerType === 'ns.changed'
                ? { statuses: nsStatuses }
                : triggerType === 'whois.expiring'
                  ? withinDays === ''
                    ? {}
                    : { withinDays: Number(withinDays) }
                  : {},
        condition: toConditionNode(condition),
        actions: toDslNodes(rows),
      };
      return editing ? workflowsApi.update(editing.id, payload) : workflowsApi.create(payload);
    },
    onSuccess: () => {
      MessagePlugin?.success?.(t('workflows.saved'));
      setDialogOpen(false);
      invalidate();
    },
    onError: (error: unknown) => {
      MessagePlugin?.error?.(error instanceof Error ? error.message : String(error));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => workflowsApi.remove(id),
    onSuccess: () => invalidate(),
  });

  const runMutation = useMutation({
    mutationFn: () =>
      workflowsApi.run(runFor!.id, {
        domainId: runDomainId,
        domainName: runDomain,
        record: { name: runName, type: 'A', value: runValue },
      }),
    onSuccess: () => {
      MessagePlugin?.success?.(t('workflows.runTriggered'));
      setRunFor(null);
    },
    onError: (error: unknown) => {
      MessagePlugin?.error?.(error instanceof Error ? error.message : String(error));
    },
  });

  function openCreate() {
    setEditing(null);
    setName('');
    setEnabled(true);
    setTriggerType('record.changed');
    setRecordTypes(['A', 'AAAA']);
    setDomainFields([]);
    setNsStatuses([]);
    setWithinDays('');
    setRows([{ ...EMPTY_ROW }]);
    setCondition({ enabled: false, field: CONDITION_FIELDS[0], op: '==', value: '' });
    setDialogOpen(true);
  }

  function openEdit(record: WorkflowRecord) {
    setEditing(record);
    setName(record.name);
    setEnabled(record.enabled);
    setTriggerType(record.triggerType);
    setRecordTypes(((record.triggerConfig?.recordTypes as string[]) ?? ['A', 'AAAA']));
    setDomainFields(((record.triggerConfig?.fields as string[]) ?? []));
    setNsStatuses(((record.triggerConfig?.statuses as string[]) ?? []));
    setWithinDays(
      typeof record.triggerConfig?.withinDays === 'number' ? String(record.triggerConfig.withinDays) : '',
    );
    setRows(fromDslNodes(record.actions));
    setCondition(fromConditionNode(record.condition));
    setDialogOpen(true);
  }

  const columns = [
    { colKey: 'name', title: t('workflows.name'), width: 200 },
    {
      colKey: 'triggerType',
      title: t('workflows.trigger'),
      width: 180,
      cell: ({ row }: { row: WorkflowRecord }) => <Tag variant="light">{row.triggerType}</Tag>,
    },
    {
      colKey: 'actions',
      title: t('workflows.actions'),
      width: 100,
      cell: ({ row }: { row: WorkflowRecord }) => String(row.actions?.length ?? 0),
    },
    {
      colKey: 'enabled',
      title: t('workflows.enabled'),
      width: 100,
      cell: ({ row }: { row: WorkflowRecord }) =>
        row.enabled ? <Tag theme="success">{t('common.enabled')}</Tag> : <Tag theme="default">{t('common.disabled')}</Tag>,
    },
    {
      colKey: 'op',
      title: t('workflows.operations'),
      cell: ({ row }: { row: WorkflowRecord }) => (
        <Space>
          <Button size="small" variant="text" onClick={() => openEdit(row)}>{t('common.edit')}</Button>
          <Button size="small" variant="text" onClick={() => setRunsFor(row)}>{t('workflows.runs')}</Button>
          <Button size="small" variant="text" onClick={() => setPreviewFor(row)}>{t('workflows.preview')}</Button>
          <Button size="small" variant="text" onClick={() => { setRunFor(row); setRunDomain(''); setRunValue(''); }}>{t('workflows.run')}</Button>
          <Button size="small" variant="text" theme="danger" onClick={() => deleteMutation.mutate(row.id)}>{t('common.delete')}</Button>
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

      <Table
        rowKey="id"
        data={items}
        columns={columns as never}
        loading={listQuery.isLoading}
        size="small"
      />

      <Dialog visible={dialogOpen} onClose={() => setDialogOpen(false)} header={editing ? t('workflows.edit') : t('workflows.create')} width="760px"
        footer={(
          <Space>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button theme="primary" loading={saveMutation.isPending} onClick={() => saveMutation.mutate()}>{t('common.save')}</Button>
          </Space>
        )}>
        <Form labelWidth="120px">
          <Form.FormItem label={t('workflows.name')}>
            <Input value={name} onChange={(value) => setName(String(value))} />
          </Form.FormItem>
          <Form.FormItem label={t('workflows.enabled')}>
            <Switch value={enabled} onChange={(value) => setEnabled(Boolean(value))} />
          </Form.FormItem>
          <Form.FormItem label={t('workflows.trigger')}>
            <Select
              value={triggerType}
              onChange={(value) => setTriggerType(String(value))}
              options={triggers.map((item) => ({ label: item.label, value: item.value }))}
            />
          </Form.FormItem>
          {triggerType === 'record.changed' && (
            <Form.FormItem label={t('workflows.recordTypes')}>
              <Checkbox.Group value={recordTypes} onChange={(value) => setRecordTypes(value as string[])}>
                <Checkbox value="A">A</Checkbox>
                <Checkbox value="AAAA">AAAA</Checkbox>
              </Checkbox.Group>
            </Form.FormItem>
          )}
          {triggerType === 'domain.changed' && (
            <Form.FormItem label={t('workflows.fields')}>
              <Checkbox.Group value={domainFields} onChange={(value) => setDomainFields(value as string[])}>
                <Checkbox value="remark">remark</Checkbox>
                <Checkbox value="is_hidden">is_hidden</Checkbox>
                <Checkbox value="enabled">enabled</Checkbox>
              </Checkbox.Group>
            </Form.FormItem>
          )}

          <Form.FormItem label={t('workflows.condition')}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Switch
                value={condition.enabled}
                onChange={(value) => setCondition({ ...condition, enabled: Boolean(value) })}
              />
              {condition.enabled && (
                <div className="workflow-condition-row">
                  <Select
                    value={condition.field}
                    options={CONDITION_FIELDS.map((field) => ({ label: field, value: field }))}
                    onChange={(value) => setCondition({ ...condition, field: String(value) })}
                  />
                  <Select
                    value={condition.op}
                    options={CONDITION_OPS.map((op) => ({ label: op, value: op }))}
                    onChange={(value) => setCondition({ ...condition, op: String(value) })}
                  />
                  <Input
                    value={condition.value}
                    placeholder={t('workflows.conditionValue')}
                    onChange={(value) => setCondition({ ...condition, value: String(value) })}
                  />
                </div>
              )}
            </Space>
          </Form.FormItem>

          {triggerType === 'ns.changed' && (
            <Form.FormItem label={t('workflows.nsStatuses')}>
              <Checkbox.Group value={nsStatuses} onChange={(value) => setNsStatuses(value as string[])}>
                {['mismatch', 'missing', 'poisoned'].map((status) => (
                  <Checkbox key={status} value={status}>{status}</Checkbox>
                ))}
              </Checkbox.Group>
            </Form.FormItem>
          )}
          {triggerType === 'whois.expiring' && (
            <Form.FormItem label={t('workflows.withinDays')}>
              <Input
                type="number"
                value={withinDays}
                onChange={(value) => setWithinDays(String(value))}
              />
            </Form.FormItem>
          )}

          <Form.FormItem label={t('workflows.actions')}>
            <Space direction="vertical" style={{ width: '100%' }}>
              {rows.map((row, index) => {
                const meta = actionMap.get(row.action);
                return (
                  <div className="workflow-action-row" key={index}>
                    <Select
                      value={row.action}
                      placeholder={t('workflows.pickAction')}
                      options={actions.filter((item) => item.dslVisible).map((item) => ({ label: item.value, value: item.value }))}
                      onChange={(value) => {
                        const next = [...rows];
                        next[index] = { action: String(value), args: {} };
                        setRows(next);
                      }}
                    />
                    {meta?.params?.map((param) => {
                      const update = (value: unknown) => {
                        const next = [...rows];
                        next[index] = { ...row, args: { ...row.args, [param.key]: String(value) } };
                        setRows(next);
                      };
                      // 参数控件按声明渲染：有 source 走级联，其次 select 走枚举，其余输入框
                      if (param.source) {
                        return (
                          <CascadingSelect
                            key={param.key}
                            param={param}
                            args={row.args}
                            value={row.args[param.key] ?? ''}
                            onChange={update}
                          />
                        );
                      }
                      if (param.type === 'select' && param.options?.length) {
                        return (
                          <Select
                            key={param.key}
                            placeholder={param.key}
                            value={row.args[param.key] ?? ''}
                            options={param.options.map((option) => ({ label: option, value: option }))}
                            onChange={update}
                          />
                        );
                      }
                      return (
                        <Input
                          key={param.key}
                          placeholder={param.key}
                          value={row.args[param.key] ?? ''}
                          onChange={update}
                        />
                      );
                    })}
                    <Button size="small" variant="text" theme="danger" onClick={() => setRows(rows.filter((_, i) => i !== index))}>
                      {t('common.delete')}
                    </Button>
                  </div>
                );
              })}
              <Button size="small" variant="outline" onClick={() => setRows([...rows, { ...EMPTY_ROW }])}>
                {t('workflows.addAction')}
              </Button>
            </Space>
          </Form.FormItem>
        </Form>
      </Dialog>

      <Dialog visible={Boolean(runsFor)} onClose={() => setRunsFor(null)} header={t('workflows.runs')} width="720px"
        footer={<Button variant="outline" onClick={() => setRunsFor(null)}>{t('common.close')}</Button>}>
        <Table
          rowKey="id"
          data={runs}
          loading={runsQuery.isLoading}
          size="small"
          columns={[
            { colKey: 'trace_id', title: 'traceId', width: 240 },
            { colKey: 'status', title: 'status', width: 100 },
            { colKey: 'started_at', title: 'started_at' },
            { colKey: 'error', title: 'error' },
          ] as never}
        />
      </Dialog>

      <Dialog visible={Boolean(previewFor)} onClose={() => setPreviewFor(null)} header={t('workflows.preview')} width="560px"
        footer={<Button variant="outline" onClick={() => setPreviewFor(null)}>{t('common.close')}</Button>}>
        {(() => {
          const event = (sampleQuery.data?.data?.data as { event?: Record<string, unknown> | null } | undefined)?.event ?? null;
          if (!event) return <div>{t('workflows.waitingForEvent')}</div>;
          const domain = (event.domain ?? {}) as { name?: string };
          const record = (event.record ?? {}) as { name?: string; type?: string; value?: string; oldValue?: string };
          return (
            <div className="workflow-preview">
              <div><strong>type</strong>: {String(event.type ?? '')}</div>
              <div><strong>domain</strong>: {domain.name ?? '-'}</div>
              <div><strong>record</strong>: {record.name ?? '-'} {record.type ?? ''}</div>
              <div><strong>value</strong>: {record.value ?? '-'}</div>
              <div><strong>oldValue</strong>: {record.oldValue ?? '-'}</div>
            </div>
          );
        })()}
      </Dialog>

      <Dialog visible={Boolean(runFor)} onClose={() => setRunFor(null)} header={t('workflows.run')} width="520px"
        footer={(
          <Space>
            <Button variant="outline" onClick={() => setRunFor(null)}>{t('common.cancel')}</Button>
            <Button theme="primary" loading={runMutation.isPending} onClick={() => runMutation.mutate()}>{t('workflows.run')}</Button>
          </Space>
        )}>
        <Form labelWidth="120px">
          <Form.FormItem label="domain">
            <Select
              value={runDomain}
              placeholder={t('workflows.pickDomain')}
              loading={domainOptionsQuery.isLoading}
              options={((domainOptionsQuery.data?.data?.data as { items?: Array<{ value: string; label: string; id: number }> } | undefined)?.items ?? [])
                .map((item) => ({ label: `${item.label} (#${item.id})`, value: item.value }))}
              onChange={(value) => {
                const picked = ((domainOptionsQuery.data?.data?.data as { items?: Array<{ value: string; id: number }> } | undefined)?.items ?? [])
                  .find((item) => item.value === String(value));
                setRunDomain(String(value));
                setRunDomainId(picked?.id ?? 0);
              }}
            />
          </Form.FormItem>
          <Form.FormItem label="record.name">
            <Input value={runName} onChange={(value) => setRunName(String(value))} />
          </Form.FormItem>
          <Form.FormItem label="record.value">
            <Input value={runValue} onChange={(value) => setRunValue(String(value))} />
          </Form.FormItem>
        </Form>
      </Dialog>
    </div>
  );
}