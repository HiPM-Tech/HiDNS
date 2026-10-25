import { useEffect, useMemo, useState } from 'react';
import { useProviders } from '../accounts/use-accounts';
import { alertVariants } from '../../ui/alert';
import { Link, useParams } from 'react-router-dom';
import {
  AlertTriangle, ArrowLeft, Download, Pencil, Plus, RefreshCw, Search, Trash2,
} from 'lucide-react';
import {
  Badge, Button, Card, CardContent, ConfirmDialog, Input, Pagination, Select, SelectContent, SelectItem,
  SelectTrigger, SelectValue, Skeleton, Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow,
} from '../../ui';
import { RecordDialog } from './record-dialog';
import { BatchImportDialog } from './batch-import-dialog';
import {
  useDeleteRecord, useDomainDetail, useRecordLines, useRecords, useRecordTypes, useToggleRecordStatus,
} from './use-records';
import { type DnsRecordRow, type RecordQuery } from './api';
import { ZoneExportDialog } from './zone-export-dialog';
import { useDomainAccounts } from '../domains/use-domains';

/** 稳定引用：避免把 `?? []` 产生的新数组传给对话框导致 effect 每次渲染都重置表单 */
const EMPTY_LINES: never[] = [];
const DEFAULT_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'SRV'];

export function RecordsPage() {
  const params = useParams<{ id: string }>();
  const domainId = Number(params.id ?? 0);

  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [type, setType] = useState('all');
  const [line, setLine] = useState('all');
  const [exportOpen, setExportOpen] = useState(false);
  const [status, setStatus] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [editing, setEditing] = useState<DnsRecordRow | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DnsRecordRow | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setKeyword(keywordInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [keywordInput]);

  const query: RecordQuery = {
    page,
    pageSize,
    keyword: keyword || undefined,
    type: type === 'all' ? undefined : type,
    line: line === 'all' ? undefined : line,
    status: status === 'all' ? undefined : status === 'enabled' ? 1 : 0,
  };

  const domain = useDomainDetail(domainId);
  const accounts = useDomainAccounts();
  // 域级写权限由后端 /domains/:id 的 can_write 透出：不可写时隐藏新建/批量导入/行内编辑
  const canWrite = (domain.data as { can_write?: boolean } | undefined)?.can_write !== false && Boolean(domain.data);
  const records = useRecords(domainId, query);
  const lines = useRecordLines(domainId);
  const types = useRecordTypes(domainId);
  const toggleStatus = useToggleRecordStatus(domainId);
  const removeRecord = useDeleteRecord(domainId);

  const lineNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of lines.data ?? []) map.set(item.id, item.name || item.id);
    return map;
  }, [lines.data]);

  // 线路可编辑性由提供商能力决定（华为云线路创建后不可改）
  const providerType = useMemo(
    () => (accounts.data ?? []).find((account) => account.id === domain.data?.account_id)?.type ?? '',
    [accounts.data, domain.data],
  );

  // 代理开关由能力位决定（此前硬编码 cloudflare/aliyunesa，和能力模型脱节）
  const providers = useProviders();
  const providerDefaultLine = useMemo(
    () => (providers.data ?? []).find((item) => item.type === providerType)?.defaultLine,
    [providers.data, providerType],
  );
  const proxyCapable = useMemo(() => {
    const provider = (providers.data ?? []).find((item) => item.type === providerType);
    return Boolean(provider?.capabilities.dns?.proxiable);
  }, [providers.data, providerType]);

  const rows = records.data?.list ?? [];
  const total = records.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const handleToggle = async (row: DnsRecordRow) => {
    setActionError(null);
    try {
      await toggleStatus.mutateAsync({ recordId: row.id, status: row.status === 1 ? 0 : 1 });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '操作失败');
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setActionError(null);
    try {
      await removeRecord.mutateAsync(pendingDelete.id);
      setPendingDelete(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '删除失败');
    }
  };

  return (
    <div className="space-y-phi-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link to="/dash/domains" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3.5 w-3.5" /> 返回域名列表
          </Link>
          <h2 className="mt-1 truncate text-heading font-semibold">
            {domain.data?.name ?? `域名 #${domainId}`}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {records.isLoading ? '加载中…' : `共 ${total} 条记录`}
            </span>
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void records.refetch()} disabled={records.isFetching}>
            <RefreshCw className={records.isFetching ? 'animate-spin' : undefined} /> 刷新
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Button variant="outline" size="sm" onClick={() => setExportOpen(true)}>
              <Download className="h-4 w-4" /> 导出 Zone
            </Button>
          </Button>
          {canWrite && (
            <Button variant="outline" size="sm" onClick={() => setBatchOpen(true)}>
              <Download className="h-4 w-4" /> 批量导入
            </Button>
          )}
          {canWrite && (
            <Button size="sm" onClick={() => { setEditing(null); setDialogOpen(true); }}>
              <Plus className="h-4 w-4" /> 新增记录
            </Button>
          )}
          {!canWrite && domain.data && <Badge variant="secondary">只读</Badge>}
        </div>
      </div>

      {actionError && (
        <div role="alert" className={alertVariants('error', 'flex items-center gap-2')}>
          <AlertTriangle className="h-4 w-4" /> {actionError}
        </div>
      )}

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="搜索主机记录或记录值"
                value={keywordInput}
                onChange={(event) => setKeywordInput(event.target.value)}
                aria-label="搜索记录"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Select value={type} onValueChange={(value) => { setType(value); setPage(1); }}>
                <SelectTrigger className="w-28" aria-label="按类型筛选"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部类型</SelectItem>
                  {(types.data ?? []).map((item: string) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={line} onValueChange={(value) => { setLine(value); setPage(1); }}>
                <SelectTrigger className="w-36" aria-label="按线路筛选"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部线路</SelectItem>
                  {(lines.data ?? []).map((item) => <SelectItem key={item.id} value={item.id}>{item.name || item.id}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={status} onValueChange={(value) => { setStatus(value as typeof status); setPage(1); }}>
                <SelectTrigger className="w-28" aria-label="按状态筛选"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  <SelectItem value="enabled">已启用</SelectItem>
                  <SelectItem value="disabled">已停用</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {records.isError ? (
            <div className="space-y-2 py-8 text-center">
              <p className="text-sm text-destructive">{records.error instanceof Error ? records.error.message : '加载失败'}</p>
              <Button variant="outline" size="sm" onClick={() => void records.refetch()}>重试</Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-40">主机记录</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>线路</TableHead>
                  <TableHead className="min-w-64">记录值</TableHead>
                  <TableHead className="text-right">TTL</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.isLoading ? (
                  Array.from({ length: 6 }, (_, index) => (
                    <TableRow key={index}><TableCell colSpan={7}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                  ))
                ) : rows.length === 0 ? (
                  <TableEmpty colSpan={7}>
                    {keyword || type !== 'all' || line !== 'all' || status !== 'all' ? '没有符合条件的记录' : '还没有解析记录'}
                  </TableEmpty>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">{row.name || '@'}</TableCell>
                      <TableCell><Badge variant="secondary">{row.type}</Badge></TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground">
                          {row.line ? (lineNameMap.get(row.line) ?? row.line) : '默认'}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <span className="block max-w-80 truncate font-mono text-xs" title={row.value}>{row.value}</span>
                          {row.cloudflare?.proxied && <Badge variant="warning">代理</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-xs">{row.ttl}</TableCell>
                      <TableCell>
                        {row.status === 1
                          ? <Badge variant="success">已启用</Badge>
                          : <Badge variant="secondary">已停用</Badge>}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`编辑 ${row.name}`}
                            onClick={() => { setEditing(row); setDialogOpen(true); }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => void handleToggle(row)} disabled={toggleStatus.isPending}>
                            {row.status === 1 ? '停用' : '启用'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:bg-destructive/10"
                            aria-label={`删除 ${row.name}`}
                            onClick={() => setPendingDelete(row)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}

          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            totalPages={totalPages}
            isFetching={records.isFetching}
            onPageChange={setPage}
            onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
          />
        </CardContent>
      </Card>
      {dialogOpen && (
        <RecordDialog
          key={editing ? 'edit-' + editing.id : 'create'}
                open
                onOpenChange={(open) => { setDialogOpen(open); if (!open) setEditing(null); }}
                domainId={domainId}
                recordTypes={types.data ?? DEFAULT_RECORD_TYPES}
                lines={lines.data ?? EMPTY_LINES}
                lineEditable={providerType !== 'huawei'}
                proxyCapable={proxyCapable}
                defaultLine={providerDefaultLine}
                record={editing}
              />
      )}

      <ZoneExportDialog open={exportOpen} onOpenChange={setExportOpen} domainId={domainId} domainName={domain?.data?.name} />

      <BatchImportDialog
        open={batchOpen}
        domainName={domain?.data?.name}
        onOpenChange={setBatchOpen}
        domainId={domainId}
        onImported={() => void records.refetch()}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除记录"
        description={
          <>
            确认删除 <span className="font-medium text-foreground">{pendingDelete?.name || '@'}</span>
            （{pendingDelete?.type}）？该操作会同步删除 DNS 提供商侧的记录。
          </>
        }
        confirmLabel="确认删除"
        pending={removeRecord.isPending}
        onConfirm={() => void handleDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
