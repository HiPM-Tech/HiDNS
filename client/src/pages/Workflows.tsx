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

  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [triggerType, setTriggerType] = useState('record.changed');
  const [recordTypes, setRecordTypes] = useState<string[]>(['A', 'AAAA']);
  const [domainFields, setDomainFields] = useState<string[]>([]);
  const [rows, setRows] = useState<ActionRow[]>([{ ...EMPTY_ROW }]);

  const [runDomain, setRunDomain] = useState('');
  const [runName, setRunName] = useState('www');
  const [runValue, setRunValue] = useState('');

  const listQuery = useQuery({ queryKey: ['workflows'], queryFn: () => workflowsApi.list() });
  const actionsQuery = useQuery({ queryKey: ['workflow-actions'], queryFn: () => workflowsApi.meta<WorkflowActionMeta[]>('actions') });
  const triggerQuery = useQuery({ queryKey: ['workflow-triggers'], queryFn: () => workflowsApi.meta('triggerTypes') });
  const runsQuery = useQuery({
    queryKey: ['workflow-runs', runsFor?.id],
    queryFn: () => workflowsApi.runs(runsFor!.id),
    enabled: Boolean(runsFor),
  });

  const items = (listQuery.data?.data as { items?: WorkflowRecord[] } | undefined)?.items ?? [];
  const actions = (actionsQuery.data?.data as { items?: WorkflowActionMeta[] } | undefined)?.items ?? [];
  const triggers = (triggerQuery.data?.data as { items?: Array<{ value: string; label: string }> } | undefined)?.items ?? [];
  const runs = (runsQuery.data?.data as { runs?: WorkflowRunRecord[] } | undefined)?.runs ?? [];

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
              : {},
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
        domainId: 0,
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
    setRows([{ ...EMPTY_ROW }]);
    setDialogOpen(true);
  }

  function openEdit(record: WorkflowRecord) {
    setEditing(record);
    setName(record.name);
    setEnabled(record.enabled);
    setTriggerType(record.triggerType);
    setRecordTypes(((record.triggerConfig?.recordTypes as string[]) ?? ['A', 'AAAA']));
    setDomainFields(((record.triggerConfig?.fields as string[]) ?? []));
    setRows(fromDslNodes(record.actions));
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
                    {meta?.params?.map((param) => (
                      <Input
                        key={param.key}
                        placeholder={param.key}
                        value={row.args[param.key] ?? ''}
                        onChange={(value) => {
                          const next = [...rows];
                          next[index] = { ...row, args: { ...row.args, [param.key]: String(value) } };
                          setRows(next);
                        }}
                      />
                    ))}
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

      <Dialog visible={Boolean(runFor)} onClose={() => setRunFor(null)} header={t('workflows.run')} width="520px"
        footer={(
          <Space>
            <Button variant="outline" onClick={() => setRunFor(null)}>{t('common.cancel')}</Button>
            <Button theme="primary" loading={runMutation.isPending} onClick={() => runMutation.mutate()}>{t('workflows.run')}</Button>
          </Space>
        )}>
        <Form labelWidth="120px">
          <Form.FormItem label="domainName">
            <Input value={runDomain} onChange={(value) => setRunDomain(String(value))} />
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