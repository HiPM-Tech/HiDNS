import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Dialog, Form, Input, Select, Switch, Space, Checkbox, MessagePlugin } from 'tdesign-react';
import { workflowsApi } from '../api';
import type { WorkflowRecord, WorkflowActionMeta, WorkflowRunRecord } from '../api';
import { Table } from '../components/Table';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CascadingSelect } from '../components/workflows/CascadingSelect';
import { useI18n } from '../contexts/I18nContext';
import { useFormSync } from '../hooks/useFormSync';
import {
  CONDITION_FIELDS,
  CONDITION_OPS,
  EMPTY_CONDITION,
  EMPTY_ROW,
  describeError,
  fromConditionNode,
  fromDslNodes,
  toConditionNode,
  toDslNodes,
  type ActionRow,
  type ConditionDraft,
} from '../utils/workflows';
import './Workflows.css';

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
  const queryClient = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WorkflowRecord | null>(null);
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

  const initial = useMemo(() => (editing ? toFormState(editing) : null), [editing]);
  const { formState, updateField } = useFormSync<WorkflowForm>(initial as WorkflowForm | null, DEFAULT_FORM, {
    fields: FORM_FIELDS,
  });

  const form = { ...DEFAULT_FORM, ...formState } as WorkflowForm;

  const listQuery = useQuery({ queryKey: ['workflows'], queryFn: () => workflowsApi.list() });
  const actionsQuery = useQuery({ queryKey: ['workflow-actions'], queryFn: () => workflowsApi.meta<WorkflowActionMeta[]>('actions') });
  const triggerQuery = useQuery({ queryKey: ['workflow-triggers'], queryFn: () => workflowsApi.meta('triggerTypes') });
  const recordTypesQuery = useQuery({ queryKey: ['workflow-meta', 'recordTypes'], queryFn: () => workflowsApi.meta<string[]>('recordTypes') });
  const domainFieldsQuery = useQuery({ queryKey: ['workflow-meta', 'domainFields'], queryFn: () => workflowsApi.meta<string[]>('domainFields') });
  const nsStatusesQuery = useQuery({ queryKey: ['workflow-meta', 'nsStatuses'], queryFn: () => workflowsApi.meta<string[]>('nsStatuses') });
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
  const recordTypes = (recordTypesQuery.data?.data?.data as { items?: string[] } | undefined)?.items ?? ['A', 'AAAA'];
  const domainFields = (domainFieldsQuery.data?.data?.data as { items?: string[] } | undefined)?.items ?? [];
  const nsStatuses = (nsStatusesQuery.data?.data?.data as { items?: string[] } | undefined)?.items ?? [];
  const domainOptions = (domainOptionsQuery.data?.data?.data as { items?: Array<{ value: string; label: string; id: number }> } | undefined)?.items ?? [];
  const runs = (runsQuery.data?.data?.data as { runs?: WorkflowRunRecord[] } | undefined)?.runs ?? [];

  const actionMap = useMemo(() => new Map(actions.map((item) => [item.value, item])), [actions]);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['workflows'] });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
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
        condition: toConditionNode(form.condition),
        actions: toDslNodes(form.rows),
      };
      return editing ? workflowsApi.update(editing.id, payload) : workflowsApi.create(payload);
    },
    onSuccess: () => {
      MessagePlugin?.success?.(t('workflows.saved'));
      setDialogOpen(false);
      invalidate();
    },
    onError: (error: unknown) => MessagePlugin?.error?.(describeError(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => workflowsApi.remove(id),
    onSuccess: () => { setPendingDelete(null); invalidate(); },
    onError: (error: unknown) => { setPendingDelete(null); MessagePlugin?.error?.(describeError(error)); },
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
        MessagePlugin?.error?.(result.error ?? t('workflows.runFailed'));
        return;
      }
      if (result.status === 'skipped') {
        MessagePlugin?.warning?.(t('workflows.runSkipped'));
        return;
      }
      MessagePlugin?.success?.(t('workflows.runTriggered'));
      setRunFor(null);
    },
    onError: (error: unknown) => MessagePlugin?.error?.(describeError(error)),
  });

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(record: WorkflowRecord) {
    setEditing(record);
    setDialogOpen(true);
  }

  const columns = [
    { key: 'name', label: t('workflows.name'), width: 200 },
    { key: 'triggerType', label: t('workflows.trigger'), width: 180 },
    { key: 'actions', label: t('workflows.actions'), width: 100, render: (row: WorkflowRecord) => String(row.actions?.length ?? 0) },
    { key: 'enabled', label: t('workflows.enabled'), width: 100, render: (row: WorkflowRecord) => (row.enabled ? t('common.enabled') : t('common.disabled')) },
    {
      key: 'op',
      label: t('workflows.operations'),
      render: (row: WorkflowRecord) => (
        <Space>
          <Button size="small" variant="text" onClick={() => openEdit(row)}>{t('common.edit')}</Button>
          <Button size="small" variant="text" onClick={() => setRunsFor(row)}>{t('workflows.runs')}</Button>
          <Button size="small" variant="text" onClick={() => setPreviewFor(row)}>{t('workflows.preview')}</Button>
          <Button size="small" variant="text" onClick={() => { setRunFor(row); setRunDomain(''); setRunDomainId(0); setRunValue(''); setRunOldValue(''); }}>{t('workflows.run')}</Button>
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
        visible={dialogOpen}
        onClose={() => setDialogOpen(false)}
        header={editing ? t('workflows.edit') : t('workflows.create')}
        width="760px"
        footer={(
          <Space>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button theme="primary" loading={saveMutation.isPending} onClick={() => saveMutation.mutate()}>{t('common.save')}</Button>
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
              options={triggers.map((item) => ({ label: item.value, value: item.value }))}
            />
          </Form.FormItem>
          {form.triggerType === 'record.changed' && (
            <Form.FormItem label={t('workflows.recordTypes')}>
              <Checkbox.Group value={form.recordTypes} onChange={(value) => updateField('recordTypes', value as string[])}>
                {recordTypes.map((type) => <Checkbox key={type} value={type}>{type}</Checkbox>)}
              </Checkbox.Group>
            </Form.FormItem>
          )}
          {form.triggerType === 'domain.changed' && (
            <Form.FormItem label={t('workflows.fields')}>
              <Checkbox.Group value={form.domainFields} onChange={(value) => updateField('domainFields', value as string[])}>
                {domainFields.map((field) => <Checkbox key={field} value={field}>{field}</Checkbox>)}
              </Checkbox.Group>
            </Form.FormItem>
          )}
          {form.triggerType === 'ns.changed' && (
            <Form.FormItem label={t('workflows.nsStatuses')}>
              <Checkbox.Group value={form.nsStatuses} onChange={(value) => updateField('nsStatuses', value as string[])}>
                {nsStatuses.map((status) => <Checkbox key={status} value={status}>{status}</Checkbox>)}
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
              {form.condition.enabled && (
                <div className="workflow-condition-row">
                  <Select
                    value={form.condition.field}
                    options={CONDITION_FIELDS.map((field) => ({ label: field.path, value: field.path }))}
                    onChange={(value) => updateField('condition', { ...form.condition, field: String(value) })}
                  />
                  <Select
                    value={form.condition.op}
                    options={CONDITION_OPS.map((op) => ({ label: op, value: op }))}
                    onChange={(value) => updateField('condition', { ...form.condition, op: String(value) })}
                  />
                  <Input
                    value={form.condition.value}
                    placeholder={t('workflows.conditionValue')}
                    onChange={(value) => updateField('condition', { ...form.condition, value: String(value) })}
                  />
                </div>
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
                      options={actions.filter((item) => item.dslVisible).map((item) => ({ label: item.value, value: item.value }))}
                      onChange={(value) => patch({ action: String(value), args: {} })}
                    />
                    {meta?.params?.map((param) => {
                      const setArg = (value: unknown) =>
                        patch({ ...row, args: { ...row.args, [param.key]: String(value) } });
                      if (param.source) {
                        return <CascadingSelect key={param.key} param={param} args={row.args} value={row.args[param.key] ?? ''} onChange={setArg} />;
                      }
                      if (param.type === 'select' && param.options?.length) {
                        return (
                          <Select
                            key={param.key}
                            placeholder={param.key}
                            value={row.args[param.key] ?? ''}
                            options={param.options.map((option) => ({ label: option, value: option }))}
                            onChange={setArg}
                          />
                        );
                      }
                      return (
                        <Input key={param.key} placeholder={param.key} value={row.args[param.key] ?? ''} onChange={setArg} />
                      );
                    })}
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
        </Form>
      </Dialog>

      <Dialog
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
            { key: 'trace_id', label: t('workflows.colTrace'), width: 240 },
            { key: 'status', label: t('workflows.colStatus'), width: 100 },
            { key: 'started_at', label: t('workflows.colStarted') },
            { key: 'error', label: t('workflows.colError') },
          ]}
        />
      </Dialog>

      <Dialog
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
              <div><strong>type</strong>: {String(event.type ?? '')}</div>
              <div><strong>domain</strong>: {domain.name ?? '-'}</div>
              <div><strong>record</strong>: {record.name ?? '-'} {record.type ?? ''}</div>
              <div><strong>value</strong>: {record.value ?? '-'}</div>
              <div><strong>oldValue</strong>: {record.oldValue ?? '-'}</div>
            </div>
          );
        })()}
      </Dialog>

      <Dialog
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
          <Form.FormItem label="domain">
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
          <Form.FormItem label="record.name">
            <Input value={runName} onChange={(value) => setRunName(String(value))} />
          </Form.FormItem>
          <Form.FormItem label="record.type">
            <Select
              value={runType}
              options={recordTypes.map((type) => ({ label: type, value: type }))}
              onChange={(value) => setRunType(String(value))}
            />
          </Form.FormItem>
          <Form.FormItem label="record.value">
            <Input value={runValue} onChange={(value) => setRunValue(String(value))} />
          </Form.FormItem>
          <Form.FormItem label="record.oldValue">
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