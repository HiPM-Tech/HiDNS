import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, DatePicker, Empty, Form, Input, Loading, Pagination, Space, Switch, Tag } from 'tdesign-react';
import { CalendarIcon, CheckIcon, CopyIcon, DeleteIcon, EditIcon, InternetIcon, KeyIcon } from 'tdesign-icons-react';
import { useToast } from '../hooks/useToast';
import { tokensApi } from '../api';
import { useI18n } from '../contexts/I18nContext';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import { Table } from '../components/Table';
import { useRealtimeData } from '../hooks/useRealtimeData';
import { formatDomainName } from '../utils/domain';

interface Token {
  id: number;
  name: string;
  allowed_domains: number[];
  start_time: string | null;
  end_time: string | null;
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
}

interface TokenDomain {
  id: number;
  name: string;
  account_name: string;
}

const DOMAIN_PAGE_SIZE = 20;

interface TokenFormState {
  name: string;
  allowed_domains: number[];
  start_time: string;
  end_time: string;
  no_expiry: boolean;
}

const tokenField = (label: ReactNode, control: ReactNode, tips?: ReactNode) => (
  <div className="settings-control-field">
    <span>{label}</span>
    {control}
    {tips && <small className="settings-control-field__tip">{tips}</small>}
  </div>
);

function createDefaultTokenForm(): TokenFormState {
  return {
    name: '',
    allowed_domains: [],
    start_time: '',
    end_time: '',
    no_expiry: false,
  };
}

function normalizeTokenForm(token?: Token | null): TokenFormState {
  return {
    name: token?.name ?? '',
    allowed_domains: Array.isArray(token?.allowed_domains) ? token!.allowed_domains.map(Number) : [],
    start_time: token?.start_time ?? '',
    end_time: token?.end_time ?? '',
    no_expiry: !token?.end_time,
  };
}

export function Tokens() {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingToken, setEditingToken] = useState<Token | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [domainSearch, setDomainSearch] = useState('');
  const [domainPage, setDomainPage] = useState(1);
  const [deleteConfirm, setDeleteConfirm] = useState<{ show: boolean; tokenId: number | null }>({ show: false, tokenId: null });
  const [formData, setFormData] = useState<TokenFormState>(() => createDefaultTokenForm());
  const [formDirty, setFormDirty] = useState(false);
  const [tokenEditKey, setTokenEditKey] = useState(0);

  useRealtimeData({
    queryKey: ['tokens'],
    websocketEventTypes: ['token_created', 'token_revoked', 'token_updated'],
    pollingInterval: 120000,
  });

  const { data: tokens = [], isLoading } = useQuery({
    queryKey: ['tokens'],
    queryFn: async () => {
      const res = await tokensApi.getAll();
      if (res.data.code === 0) return res.data.data as Token[];
      throw new Error(res.data.msg);
    },
  });

  const { data: domains = [], isLoading: isLoadingDomains } = useQuery({
    queryKey: ['token-domains'],
    queryFn: async () => {
      const res = await tokensApi.getDomains();
      if (res.data.code === 0) return res.data.data as TokenDomain[];
      throw new Error(res.data.msg);
    },
  });

  const createMutation = useMutation({
    mutationFn: tokensApi.create,
    onSuccess: (res) => {
      if (res.data.code === 0) {
        setNewToken(res.data.data.token);
        queryClient.invalidateQueries({ queryKey: ['tokens'] });
        toast.success(t('tokens.tokenCreated'));
      } else {
        toast.error(res.data.msg);
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof tokensApi.update>[1] }) =>
      tokensApi.update(id, data),
    onSuccess: (res) => {
      if (res.data.code === 0) {
        queryClient.invalidateQueries({ queryKey: ['tokens'] });
        toast.success(t('tokens.tokenUpdated'));
        closeEditModal();
      } else {
        toast.error(res.data.msg);
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => tokensApi.delete(id),
    onSuccess: (res) => {
      if (res.data.code === 0) {
        queryClient.invalidateQueries({ queryKey: ['tokens'] });
        toast.success(t('tokens.tokenDeleted'));
        setDeleteConfirm({ show: false, tokenId: null });
      } else {
        toast.error(res.data.msg);
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) => tokensApi.toggleStatus(id, is_active),
    onSuccess: (res) => {
      if (res.data.code === 0) {
        queryClient.invalidateQueries({ queryKey: ['tokens'] });
        toast.success(t('tokens.tokenStatusUpdated'));
      } else {
        toast.error(res.data.msg);
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const filteredDomains = domains.filter((domain) => (
    domain.name.toLowerCase().includes(domainSearch.toLowerCase()) ||
    domain.account_name.toLowerCase().includes(domainSearch.toLowerCase())
  ));
  const paginatedDomains = filteredDomains.slice((domainPage - 1) * DOMAIN_PAGE_SIZE, domainPage * DOMAIN_PAGE_SIZE);
  const currentEditingToken = editingToken;

  useEffect(() => {
    if (showCreateModal) {
      if (!formDirty) {
        setFormData(createDefaultTokenForm());
      }
      return;
    }

    if (!currentEditingToken) {
      setFormData(createDefaultTokenForm());
      setFormDirty(false);
    }
  }, [
    showCreateModal,
    formDirty,
  ]);

  const updateField = <K extends keyof TokenFormState>(field: K, value: TokenFormState[K]) => {
    setFormData((current) => ({ ...current, [field]: value }));
    setFormDirty(true);
  };

  const resetForm = () => {
    setNewToken(null);
    setDomainSearch('');
    setDomainPage(1);
    setFormData(createDefaultTokenForm());
    setFormDirty(false);
  };

  const closeModal = () => {
    setShowCreateModal(false);
    resetForm();
  };

  const closeEditModal = () => {
    setEditingToken(null);
    resetForm();
  };

  const openCreateModal = () => {
    resetForm();
    setShowCreateModal(true);
  };

  const handleEdit = (token: Token) => {
    setFormData(normalizeTokenForm(token));
    setFormDirty(false);
    setEditingToken(token);
    setTokenEditKey(prev => prev + 1);
  };

  const buildPayload = () => ({
    name: formData.name.trim(),
    allowed_domains: formData.allowed_domains || [],
    start_time: formData.start_time || undefined,
    end_time: formData.no_expiry ? undefined : (formData.end_time || undefined),
  });

  const handleCreate = () => {
    if (!formData.name.trim()) {
      toast.error(t('tokens.tokenNameRequired'));
      return;
    }
    createMutation.mutate(buildPayload());
  };

  const handleUpdate = () => {
    if (!editingToken) return;
    if (!formData.name.trim()) {
      toast.error(t('tokens.tokenNameRequired'));
      return;
    }
    updateMutation.mutate({ id: editingToken.id, data: buildPayload() });
  };

  const handleCopyToken = async () => {
    if (!newToken) return;
    try {
      await navigator.clipboard.writeText(newToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t('tokens.copyFailed'));
    }
  };

  const formatDate = (date: string | null) => {
    if (!date) return t('tokens.noExpiry');
    return new Date(date).toLocaleString();
  };

  const selectAllFiltered = () => {
    const filteredIds = filteredDomains.map((domain) => domain.id);
    updateField('allowed_domains', [...new Set([...(formData.allowed_domains || []), ...filteredIds])]);
  };

  const clearAllSelection = () => {
    updateField('allowed_domains', []);
  };

  const toggleDomain = (domainId: number, checked: boolean) => {
    updateField('allowed_domains', checked
      ? [...new Set([...(formData.allowed_domains || []), domainId])]
      : (formData.allowed_domains || []).filter((id: number) => id !== domainId)
    );
  };

  const columns = [
    {
      key: 'name',
      label: t('tokens.tokenName'),
      render: (token: Token) => (
        <Space size="small">
          <KeyIcon />
          <span className="page-strong">{token.name}</span>
        </Space>
      ),
    },
    {
      key: 'domains',
      label: t('tokens.domains'),
      render: (token: Token) => (
        <Tag variant="light">
          {token.allowed_domains.length === 0 ? t('tokens.allDomains') : t('tokens.domainCount', { count: token.allowed_domains.length })}
        </Tag>
      ),
    },
    {
      key: 'expires',
      label: t('tokens.expiresAt'),
      render: (token: Token) => (
        <span className="page-muted">{formatDate(token.start_time)} - {token.end_time ? formatDate(token.end_time) : t('tokens.noExpiry')}</span>
      ),
    },
    {
      key: 'status',
      label: t('tokens.status'),
      render: (token: Token) => (
        <Switch
          size="small"
          value={Boolean(token.is_active)}
          onChange={(checked: any) => toggleMutation.mutate({ id: token.id, is_active: Boolean(checked) })}
        />
      ),
    },
    {
      key: 'last_used_at',
      label: t('tokens.lastUsedAt'),
      render: (token: Token) => <span className="page-muted">{token.last_used_at ? new Date(token.last_used_at).toLocaleString() : t('tokens.neverUsed')}</span>,
    },
    {
      key: 'actions',
      label: t('tokens.actions'),
      render: (token: Token) => (
        <Space size="small">
          <Button shape="square" variant="text" icon={<EditIcon />} onClick={() => handleEdit(token)} />
          <Button shape="square" variant="text" theme="danger" icon={<DeleteIcon />} onClick={() => setDeleteConfirm({ show: true, tokenId: token.id })} />
        </Space>
      ),
    },
  ];

  const renderDomainSelector = () => (
    <Card bordered className="token-domain-card">
      <div className="token-domain-toolbar">
        <Input
          clearable
          type="search"
          name="token-domain-search"
          autocomplete="off"
          value={domainSearch}
          prefixIcon={<InternetIcon />}
          placeholder={t('tokens.searchDomains')}
          onChange={(value) => {
            setDomainSearch(String(value));
            setDomainPage(1);
          }}
        />
        <Space>
          <Button variant="outline" size="small" onClick={selectAllFiltered}>
            {t('tokens.selectAllFiltered')}
          </Button>
          <Button variant="outline" size="small" onClick={clearAllSelection}>
            {t('tokens.clearAll')}
          </Button>
        </Space>
      </div>

      <div className="token-domain-summary">
        <span>{t('tokens.selectedCount', { count: formData.allowed_domains?.length || 0 })}</span>
        <span>{t('tokens.allDomainsAllowed')}</span>
      </div>

      {isLoadingDomains ? (
        <div className="page-state"><Loading loading size="small" text={t('common.loading')} /></div>
      ) : domains.length === 0 ? (
        <Empty description={t('tokens.noDomains')} />
      ) : filteredDomains.length === 0 ? (
        <Empty description={t('tokens.noMatchingDomains')} />
      ) : (
        <>
          <div className="page-list page-list--scroll">
            <label className="token-domain-all">
              <Checkbox
                checked={(formData.allowed_domains?.length || 0) === 0}
                onChange={(checked: any) => {
                  if (checked) clearAllSelection();
                }}
              />
              <span className="page-strong">{t('tokens.allDomains')}</span>
            </label>
            {paginatedDomains.map((domain) => (
              <label key={domain.id} className="token-domain-option">
                <Checkbox
                  checked={(formData.allowed_domains || []).includes(domain.id)}
                  onChange={(checked: any) => toggleDomain(domain.id, Boolean(checked))}
                />
                <span className="page-list-item__main">
                  <strong>{formatDomainName(domain.name)}</strong>
                  <span>{domain.account_name}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="token-domain-pagination">
            <Pagination
              current={domainPage}
              pageSize={DOMAIN_PAGE_SIZE}
              total={filteredDomains.length}
              showPageSize={false}
              showJumper={false}
              onCurrentChange={(current) => setDomainPage(current)}
            />
          </div>
        </>
      )}
    </Card>
  );

  const renderTokenForm = (mode: 'create' | 'edit') => (
    <Form layout="vertical" colon={false} requiredMark={false} className="page-shell token-form" onSubmit={({ e }: any) => { e?.preventDefault(); if (mode === 'create') { handleCreate(); } else { handleUpdate(); } }}>
      {tokenField(t('tokens.tokenName'),
        <Input
          name={mode === 'create' ? 'token-create-name' : `token-edit-name-${editingToken?.id ?? 'draft'}`}
          autocomplete="off"
          value={String(formData.name)}
          onChange={(value: any) => updateField('name', String(value))}
          placeholder={t('tokens.tokenNamePlaceholder')}
        />
      )}

      {tokenField(<Space size="small"><InternetIcon />{t('tokens.allowedDomains')}</Space>, renderDomainSelector())}

      <div className="token-time-grid">
        {tokenField(<Space size="small"><CalendarIcon />{t('tokens.startTime')}</Space>,
          <DatePicker
            clearable
            enableTimePicker
            format="YYYY-MM-DD HH:mm:ss"
            valueType="YYYY-MM-DD HH:mm:ss"
            value={String(formData.start_time)}
            onChange={(value: any) => updateField('start_time', String(value ?? ''))}
          />,
          t('tokens.startTimeHint')
        )}
        {tokenField(<Space size="small"><CalendarIcon />{t('tokens.endTime')}</Space>,
          <DatePicker
            clearable
            enableTimePicker
            disabled={formData.no_expiry}
            format="YYYY-MM-DD HH:mm:ss"
            valueType="YYYY-MM-DD HH:mm:ss"
            value={String(formData.end_time)}
            onChange={(value: any) => {
              updateField('end_time', String(value ?? ''));
              updateField('no_expiry', false);
            }}
          />,
          t('tokens.endTimeHint')
        )}
        <div className="settings-control-field token-no-expiry-item">
          <span aria-hidden="true">&nbsp;</span>
          <Checkbox
            checked={formData.no_expiry}
            onChange={(checked: any) => {
              updateField('no_expiry', Boolean(checked));
              if (checked) updateField('end_time', '');
            }}
          >
            {t('tokens.noExpiry')}
          </Checkbox>
        </div>
      </div>

      <Alert theme="info" message={`${t('common.remark')}: ${t('tokens.tokenTip')}`} />

      <Space className="record-form__actions">
        <Button variant="outline" onClick={mode === 'create' ? closeModal : closeEditModal}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" theme="primary" loading={mode === 'create' ? createMutation.isPending : updateMutation.isPending} disabled={!formData.name.trim()}>
          {mode === 'create' ? t('tokens.createToken') : t('common.save')}
        </Button>
      </Space>
    </Form>
  );

  return (
    <div className="page-shell">
      <section className="page-heading">
        <div>
          <h1>{t('tokens.title')}</h1>
          <p>{t('tokens.subtitle')}</p>
        </div>
        <Button theme="primary" icon={<KeyIcon />} onClick={openCreateModal}>
          {t('tokens.createToken')}
        </Button>
      </section>

      <Card bordered={false} shadow={false} className="page-card">
        <Table columns={columns} data={tokens} loading={isLoading} rowKey={(token) => token.id} emptyText={t('tokens.noTokens')} />
      </Card>

      {deleteConfirm.show && (
        <ConfirmDialog
          message={t('tokens.deleteConfirm')}
          onConfirm={() => {
            if (deleteConfirm.tokenId !== null) deleteMutation.mutate(deleteConfirm.tokenId);
          }}
          onCancel={() => setDeleteConfirm({ show: false, tokenId: null })}
          isLoading={deleteMutation.isPending}
        />
      )}

      {showCreateModal && (
        <Modal title={newToken ? t('tokens.tokenCreated') : t('tokens.createToken')} onClose={closeModal} size="lg">
          {newToken ? (
            <div className="page-shell">
              <Alert theme="success" message={t('tokens.copyToken')} />
              <div className="token-code-box">
                <code>{newToken}</code>
                <Button shape="square" theme="primary" icon={copied ? <CheckIcon /> : <CopyIcon />} onClick={handleCopyToken} />
              </div>
              <Space className="record-form__actions">
                <Button theme="primary" onClick={closeModal}>{t('common.confirmAction')}</Button>
              </Space>
            </div>
          ) : renderTokenForm('create')}
        </Modal>
      )}

      {editingToken && (
        <Modal key={`edit-token-${editingToken.id}-${tokenEditKey}`} title={t('tokens.editToken')} onClose={closeEditModal} size="lg">
          {renderTokenForm('edit')}
        </Modal>
      )}
    </div>
  );
}
