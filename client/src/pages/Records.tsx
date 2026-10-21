import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Input, Pagination, Radio, RadioGroup, Select, Space, Switch, Tabs, Tag } from 'tdesign-react';
import type { SelectValue } from 'tdesign-react/es/select';
import { AddIcon, ArrowLeftIcon, DeleteIcon, EditIcon, FileExportIcon, MailIcon, RefreshIcon, SearchIcon } from 'tdesign-icons-react';
import { recordsApi, domainsApi, accountsApi } from '../api';
import type { DnsRecord } from '../api';
import { Table } from '../components/Table';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../hooks/useToast';
import { useI18n } from '../contexts/I18nContext';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { TunnelList } from '../components/TunnelList';
import { MailSetupModal } from './MailSetupModal';
import { RecordForm } from '../components/RecordForm';
import { COMMON_RECORD_TYPES, CLOUDFLARE_RECORD_TYPES } from '../types/record-types';
import type { RecordType } from '../types/record-types';
import { useRealtimeData } from '../hooks/useRealtimeData';

function selectToString(value: SelectValue) {
  return String(Array.isArray(value) ? value[0] ?? '' : value);
}

export function Records() {
  const { id } = useParams<{ id: string }>();
  const domainId = Number(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useI18n();
  const formatApiError = (msg?: string) => {
    if (!msg) return t('common.error');
    if (msg === 'Permission denied') return t('common.permissionDenied');
    if (msg === 'Permission denied for subdomain') return t('common.permissionDeniedSubdomain');
    return msg;
  };

  const [showAdd, setShowAdd] = useState(false);
  const [showMailSetup, setShowMailSetup] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportNameFormat, setExportNameFormat] = useState<'relative' | 'full'>('relative');
  const [editing, setEditing] = useState<DnsRecord | null>(null);
  const [editingKey, setEditingKey] = useState(0); // ✅ 用于强制重新挂载
  const [deleting, setDeleting] = useState<DnsRecord | null>(null);
  const [typeFilter, setTypeFilter] = useState('');
  const [keyword, setKeyword] = useState('');
  const [activeTab, setActiveTab] = useState<'records' | 'tunnels'>('records');
  const [showTunnels] = useLocalStorage('showTunnels', false);
  
  // 分页状态
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const { data: domain } = useQuery({
    queryKey: ['domain', domainId],
    queryFn: () => domainsApi.get(domainId).then((r) => r.data.data),
  });

  // 检查域名是否被禁用
  useEffect(() => {
    if (domain && domain.enabled === 0) {
      toast.error(t('domains.domainDisabled'));
      navigate('/dash/domains');
    }
  }, [domain, navigate, toast, t]);

  const { data: account } = useQuery({
    queryKey: ['account-for-domain', domain?.account_id],
    enabled: Boolean(domain?.account_id),
    queryFn: () => accountsApi.get(domain!.account_id).then((r) => r.data.data),
  });

  const { data: providers = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => accountsApi.providers().then((r) => r.data.data),
  });

  const currentProvider = useMemo(() => {
    if (!account) return undefined;
    return providers.find(p => p.type === account.type);
  }, [account, providers]);

  const { data: recordTypeNames = [] } = useQuery({
    queryKey: ['domain-record-types', domainId],
    queryFn: () => domainsApi.recordTypes(Number(domainId)).then((r) => r.data.data),
    enabled: !!domainId,
  });

  const providerRecordTypes = useMemo(() => {
    const base = Array.isArray(recordTypeNames) && recordTypeNames.length > 0
      ? [...recordTypeNames as RecordType[]]
      : account?.type === 'cloudflare'
        ? [...CLOUDFLARE_RECORD_TYPES]
        : [...COMMON_RECORD_TYPES];
    if (editing?.type && !base.includes(editing.type)) base.push(editing.type);
    return base;
  }, [recordTypeNames, account?.type, editing?.type]);

  useEffect(() => {
    if (typeFilter && !providerRecordTypes.includes(typeFilter as RecordType)) {
      setTypeFilter('');
    }
  }, [providerRecordTypes, typeFilter]);

  // 实时数据：DNS记录变更
  useRealtimeData({
    queryKey: ['records', domainId],
    websocketEventTypes: ['record_created', 'record_updated', 'record_deleted', 'record_status_changed'],
    pollingInterval: 30000, // 30秒（记录变化更频繁）
  });

  const { data: recordsData, isLoading } = useQuery({
    queryKey: ['records', domainId, typeFilter, keyword, page, pageSize],
    queryFn: () => recordsApi.list(domainId, {
      type: typeFilter || undefined,
      keyword: keyword || undefined,
      page,
      pageSize,
    }).then((r) => r.data.data ?? { total: 0, list: [] }),
  });
  
  const records = recordsData?.list ?? [];
  const total = recordsData?.total ?? 0;
  
  const { data: lines = [] } = useQuery({
    queryKey: ['lines', domainId],
    queryFn: () => domainsApi.lines(domainId).then((r) => r.data.data ?? []),
  });

  const createMutation = useMutation({
    mutationFn: (data: Partial<DnsRecord>) => recordsApi.create(domainId, data),
    onSuccess: (res) => {
      if (res.data.code !== 0) { toast.error(formatApiError(res.data.msg)); return; }
      qc.invalidateQueries({ queryKey: ['records', domainId] });
      setShowAdd(false);
      toast.success(t('records.addSuccess'));
    },
    onError: () => toast.error(t('records.addFailed')),
  });

  const updateMutation = useMutation({
    mutationFn: ({ recordId, data }: { recordId: string; data: Partial<DnsRecord> }) =>
      recordsApi.update(domainId, recordId, data),
    onSuccess: (res) => {
      if (res.data.code !== 0) { toast.error(formatApiError(res.data.msg)); return; }
      qc.invalidateQueries({ queryKey: ['records', domainId] });
      setEditing(null);
      toast.success(t('records.updateSuccess'));
    },
    onError: () => toast.error(t('records.updateFailed')),
  });

  const deleteMutation = useMutation({
    mutationFn: (recordId: string) => recordsApi.delete(domainId, recordId),
    onSuccess: (res) => {
      if (res.data.code !== 0) { toast.error(formatApiError(res.data.msg)); return; }
      qc.invalidateQueries({ queryKey: ['records', domainId] });
      setDeleting(null);
      toast.success(t('records.deleteSuccess'));
    },
    onError: () => toast.error(t('records.deleteFailed')),
  });

  const statusMutation = useMutation({
    mutationFn: ({ recordId, status }: { recordId: string; status: number }) =>
      recordsApi.setStatus(domainId, recordId, status),
    onSuccess: (res, { recordId }) => {
      if (res.data.code !== 0) { toast.error(formatApiError(res.data.msg)); return; }
      qc.invalidateQueries({ queryKey: ['records', domainId] });
      toast.success(t('records.toggled', { status: records.find((r) => r.id === recordId)?.status === 1 ? t('common.disabled') : t('common.enabled') }));
    },
    onError: () => toast.error(t('records.toggleFailed')),
  });

  const handleExportZone = useCallback(async () => {
    setExportNameFormat('relative');
    setShowExportDialog(true);
  }, []);

  const handleExportDownload = useCallback(async () => {
    setShowExportDialog(false);
    try {
      const res = await recordsApi.exportZone(domainId, exportNameFormat);
      if (res.data.code !== 0) { toast.error(formatApiError(res.data.msg)); return; }
      const { content, filename } = res.data.data;
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(t('records.exportZoneSuccess'));
    } catch (e) {
      toast.error(t('records.exportZoneFailed'));
    }
  }, [domainId, exportNameFormat, toast, t]);

  const lineMap = useMemo(() => Object.fromEntries(lines.map((l) => [l.id, l.name || l.id])), [lines]);

  const hasProxyMode = currentProvider?.capabilities?.dns?.proxiable === true;

  const columns = useMemo(() => [
    {
      key: 'name',
      label: t('common.host'),
      width: 220,
      // 顺带把记录 ID 挂在主机名后面：工作流的 recordId 参数要填它，
      // 而此前界面上任何地方都看不到这个值，等于那三个动作无从配置。
      render: (r: DnsRecord) => (
        <span className="record-mono record-mono--strong" title={r.name}>
          {r.name}
          {r.id ? <span className="record-id"> #{r.id}</span> : null}
        </span>
      ),
    },
    { key: 'type', label: t('common.type'), width: 80, render: (r: DnsRecord) => <Tag theme="primary" variant="light">{r.type}</Tag> },
    {
      key: 'value', label: t('common.value'), width: 250,
      render: (r: DnsRecord) => (
        <Space size="small">
          <span className="record-mono record-mono--value" title={r.value}>{r.value}</span>
          {r.type === 'MX' && r.mx !== undefined && (
            <Tag theme="warning" variant="light" title={t('records.mxPriority')}>{r.mx}</Tag>
          )}
        </Space>
      ),
    },
    {
      key: 'line', label: hasProxyMode ? t('records.proxy') : t('common.line'), width: 100,
      render: (r: DnsRecord) => {
        // Cloudflare & Aliyun ESA: 显示代理状态（是/否）
        if (hasProxyMode) {
          const proxied = r.line === '1';
          return <Tag theme={proxied ? 'warning' : 'default'} variant="light">{proxied ? t('records.proxied') : t('records.dnsOnly')}</Tag>;
        }
        // 其他提供商: 显示线路
        const effectiveLine = r.line;

        // 当线路为 '0'、'default' 或空时，显示为"默认"
        if (!effectiveLine || effectiveLine === '0' || effectiveLine === 'default') {
          return <Tag theme="default" variant="light">{t('records.defaultLine') || '默认'}</Tag>;
        }

        // 显示具体线路名称
        const lineName = lineMap[effectiveLine];
        return <Tag theme="primary" variant="light">{lineName ?? effectiveLine}</Tag>;
      },
    },
    { key: 'ttl', label: t('common.ttl'), width: 80, render: (r: DnsRecord) => <span className="page-muted">{r.ttl ?? '-'}</span> },
    {
      key: 'status', label: t('common.status'), width: 90,
      render: (r: DnsRecord) => (
        <Tag theme={r.status === 1 ? 'success' : 'danger'} variant="light">
          {r.status === 1 ? t('common.enabled') : t('common.disabled')}
        </Tag>
      ),
    },
    {
      key: 'actions', label: t('common.actions'), width: 140,
      render: (r: DnsRecord) => (
        <Space size="small">
          <Switch
            size="small"
            value={r.status === 1}
            onChange={(checked) => statusMutation.mutate({ recordId: r.id, status: checked ? 1 : 0 })}
          />
          <Button shape="square" variant="text" icon={<EditIcon />} onClick={() => {
            setEditingKey(prev => prev + 1); // ✅ 递增 key，强制重新挂载
            setEditing(r);
          }} />
          <Button shape="square" variant="text" theme="danger" icon={<DeleteIcon />} onClick={() => setDeleting(r)} />
        </Space>
      ),
    },
  ], [t, hasProxyMode, lineMap, statusMutation]);

  return (
    <div className="page-shell">
      <section className="page-heading">
        <div className="page-actions">
          <Button shape="square" variant="text" icon={<ArrowLeftIcon />} onClick={() => navigate('/dash/domains')} />
          <div>
            <h1>{domain?.name ?? t('records.title')}</h1>
            <p>{t('records.subtitle')}</p>
          </div>
        </div>
        {activeTab === 'records' && (
          <Space>
            <Button variant="outline" icon={<RefreshIcon />} onClick={() => qc.invalidateQueries({ queryKey: ['records', domainId] })}>
              {t('records.refresh')}
            </Button>
            <Button variant="outline" icon={<FileExportIcon />} onClick={handleExportZone}>
              {t('records.exportZone')}
            </Button>
            <Button theme="primary" icon={<AddIcon />} onClick={() => setShowAdd(true)}>
              {t('records.addRecord')}
            </Button>
            <Button variant="outline" icon={<MailIcon />} onClick={() => setShowMailSetup(true)}>
              {t('mail.title')}
            </Button>
          </Space>
        )}
      </section>

      {showTunnels && currentProvider?.type === 'cloudflare' && (
        <Tabs
          className="page-tabs"
          theme="card"
          value={activeTab}
          list={[
            { value: 'records', label: t('records.dnsRecords') },
            { value: 'tunnels', label: t('records.tunnels') },
          ]}
          onChange={(value) => setActiveTab(value as 'records' | 'tunnels')}
        />
      )}

      {activeTab === 'records' && (
        <>
          <Card bordered={false} shadow={false} className="page-card records-card">
            <div className="records-toolbar records-card__toolbar">
              <Input
                clearable
                type="search"
                name="records-search"
                autocomplete="off"
                value={keyword}
                prefixIcon={<SearchIcon />}
                placeholder={t('common.searchRecords')}
                onChange={(value) => {
                  setKeyword(String(value));
                  setPage(1);
                }}
              />
              <Select
                value={typeFilter}
                options={[
                  { label: t('records.allTypes'), value: '' },
                  ...providerRecordTypes.map((type) => ({ label: type, value: type })),
                ]}
                onChange={(value) => {
                  setTypeFilter(selectToString(value));
                  setPage(1);
                }}
              />
            </div>
            <Table columns={columns} data={records} loading={isLoading} rowKey={(r) => r.id} emptyText={t('records.noRecords')} maxHeight={620} />
            <div className="records-pagination">
              <Pagination
                current={page}
                pageSize={pageSize}
                total={total}
                pageSizeOptions={[10, 20, 50, 100]}
                onCurrentChange={(current) => setPage(current)}
                onPageSizeChange={(nextPageSize) => {
                  setPageSize(nextPageSize);
                  setPage(1);
                }}
              />
            </div>
          </Card>
        </>
      )}

      {activeTab === 'tunnels' && (
        <TunnelList accountId={domain?.account_id} />
      )}

      {showAdd && (
        <Modal title={t('records.addRecordFor', { name: domain?.name ?? '' })} onClose={() => setShowAdd(false)} size="lg">
          <RecordForm
            key="create"
            domainId={domainId}
            lines={lines}
            recordTypes={providerRecordTypes}
            provider={currentProvider}
            existingRecords={records}
            onSubmit={(data) => createMutation.mutate(data)}
            isLoading={createMutation.isPending}
          />
        </Modal>
      )}

      {showMailSetup && (
        <MailSetupModal domainId={domainId} domainName={domain?.name ?? ''} onClose={() => setShowMailSetup(false)} existingRecords={records} />
      )}

      {showExportDialog && (
        <Modal title={t('records.exportZone')} onClose={() => setShowExportDialog(false)} size="sm">
          <div style={{ padding: '8px 0' }}>
            <p style={{ margin: '0 0 16px', color: 'var(--td-text-color-secondary)', fontSize: 14, lineHeight: '22px' }}>
              {t('records.exportZoneHint')}
            </p>
            <RadioGroup value={exportNameFormat} onChange={(v) => setExportNameFormat(v as 'relative' | 'full')}>
              <Radio value="relative" style={{ display: 'block', marginBottom: 12 }}>
                <span style={{ fontWeight: 600 }}>{t('records.exportZoneRelative')}</span>
                <br />
                <span style={{ fontSize: 12, color: 'var(--td-text-color-placeholder)' }}>{t('records.exportZoneRelativeDesc')}</span>
              </Radio>
              <Radio value="full" style={{ display: 'block' }}>
                <span style={{ fontWeight: 600 }}>{t('records.exportZoneFull')}</span>
                <br />
                <span style={{ fontSize: 12, color: 'var(--td-text-color-placeholder)' }}>{t('records.exportZoneFullDesc')}</span>
              </Radio>
            </RadioGroup>
            <div style={{ marginTop: 24, textAlign: 'right' }}>
              <Button variant="outline" onClick={() => setShowExportDialog(false)} style={{ marginRight: 8 }}>
                {t('common.cancel')}
              </Button>
              <Button theme="primary" onClick={handleExportDownload}>
                {t('records.exportZoneConfirm')}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {editing && (
        <Modal title={t('records.editRecord')} onClose={() => setEditing(null)} size="lg">
          <RecordForm
            key={`edit-${editing.id}-${editingKey}`}
            domainId={domainId}
            lines={lines}
            recordTypes={providerRecordTypes}
            provider={currentProvider}
            existingRecords={records}
            initial={editing}
            onSubmit={(data) => updateMutation.mutate({ recordId: editing.id, data })}
            isLoading={updateMutation.isPending}
          />
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          message={t('records.deleteConfirm', { name: deleting.name, type: deleting.type, value: deleting.value })}
          onConfirm={() => deleteMutation.mutate(deleting.id)}
          onCancel={() => setDeleting(null)}
          isLoading={deleteMutation.isPending}
        />
      )}
    </div>
  );
}
