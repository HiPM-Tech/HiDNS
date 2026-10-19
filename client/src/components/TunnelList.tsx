import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Space, Tag } from 'tdesign-react';
import { DeleteIcon } from 'tdesign-icons-react';
import { tunnelsApi } from '../api';
import { Table } from './Table';
import { useToast } from '../hooks/useToast';
import { ConfirmDialog } from './ConfirmDialog';
import { useI18n } from '../contexts/I18nContext';

interface TunnelRow {
  id: string;
  account_id: string;
  account_name: string;
  name: string;
  status: string;
  created_at: string;
}

export function TunnelList({ accountId }: { accountId?: number }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [deleting, setDeleting] = useState<TunnelRow | null>(null);

  const { data: tunnels = [], isLoading } = useQuery({
    queryKey: ['tunnels'],
    queryFn: () => tunnelsApi.list().then((r) => (r.data.data ?? []) as TunnelRow[]),
  });

  const filteredTunnels = accountId ? tunnels.filter((tunnel: TunnelRow) => Number(tunnel.account_id) === accountId) : tunnels;

  const deleteMutation = useMutation({
    mutationFn: ({ accId, tunnelId }: { accId: string; tunnelId: string }) =>
      tunnelsApi.delete(accId, tunnelId),
    onSuccess: (res) => {
      if (res.data.code !== 0) {
        toast.error(res.data.msg);
        return;
      }
      qc.invalidateQueries({ queryKey: ['tunnels'] });
      setDeleting(null);
      toast.success(t('tunnels.deleteSuccess'));
    },
    onError: () => toast.error(t('tunnels.deleteFailed')),
  });

  const columns = [
    { key: 'name', label: t('tunnels.tunnelName'), render: (row: TunnelRow) => <span className="page-strong">{row.name}</span> },
    {
      key: 'status',
      label: t('audit.fields.status'),
      render: (row: TunnelRow) => (
        <Tag theme={row.status === 'active' ? 'success' : 'default'} variant="light">
          {t(row.status === 'active' ? 'common.active' : 'common.inactive')}
        </Tag>
      ),
    },
    { key: 'account', label: t('accounts.provider'), render: (row: TunnelRow) => <span className="page-muted">{row.account_name}</span> },
    { key: 'created_at', label: t('common.createdAt'), render: (row: TunnelRow) => <span className="page-muted">{new Date(row.created_at).toLocaleString()}</span> },
    {
      key: 'actions',
      label: t('domains.actions'),
      render: (row: TunnelRow) => (
        <Space size="small">
          <Button shape="square" variant="text" theme="danger" icon={<DeleteIcon />} onClick={() => setDeleting(row)} />
        </Space>
      ),
    },
  ];

  return (
    <>
      <Card bordered={false} shadow={false} className="page-card">
        <Table columns={columns} data={filteredTunnels} loading={isLoading} rowKey={(row) => row.id} emptyText={t('tunnels.notFound')} />
      </Card>
      {deleting && (
        <ConfirmDialog
          message={t('tunnels.deleteConfirm', { name: deleting.name })}
          onConfirm={() => deleteMutation.mutate({ accId: deleting.account_id, tunnelId: deleting.id })}
          onCancel={() => setDeleting(null)}
          isLoading={deleteMutation.isPending}
        />
      )}
    </>
  );
}
