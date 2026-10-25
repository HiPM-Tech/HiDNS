import { useEffect, useMemo, useState } from 'react';
import { alertVariants } from '../../ui/alert';
import { AlertTriangle, Loader2, Plus, Radar, RefreshCw, Search, ShieldCheck, Trash2, Wand2 } from 'lucide-react';
import {
  Badge, Button, Card, CardContent, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, Input, Label, Pagination, Select, SelectContent, SelectItem, SelectTrigger,
  SelectValue, Skeleton, Switch, Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow,
} from '../../ui';
import { formatRelative } from '../../lib/format';
import {
  addNsMonitor, checkNsRecord, deleteNsMonitor, listAvailableDomains, listNsMonitors, resolveNs,
  updateNsMonitor, type NsMonitorRow,
} from './ns-monitor-api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

const STATUS_LABEL: Record<string, { label: string; variant: 'success' | 'warning' | 'destructive' | 'secondary' }> = {
  ok: { label: '正常', variant: 'success' },
  mismatch: { label: '不一致', variant: 'destructive' },
  missing: { label: '缺失', variant: 'warning' },
};

const PAGE_SIZES = [20, 50, 100];

export function NsMonitorTab() {
  const queryClient = useQueryClient();
  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ mode: 'create' } | { mode: 'edit'; row: NsMonitorRow } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<NsMonitorRow | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => { setKeyword(keywordInput.trim()); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [keywordInput]);

  const monitors = useQuery({
    queryKey: ['ns-monitors', page, pageSize, keyword],
    queryFn: () => listNsMonitors({ page, pageSize, keyword: keyword || undefined }),
    staleTime: 20_000,
  });

  const invalidate = () => { void queryClient.invalidateQueries({ queryKey: ['ns-monitors'] }); };

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => updateNsMonitor(id, { enabled }),
    onSuccess: invalidate,
  });
  const recheck = useMutation({ mutationFn: (domainName: string) => checkNsRecord(domainName) });
  const remove = useMutation({ mutationFn: (id: number) => deleteNsMonitor(id), onSuccess: invalidate });

  const rows = monitors.data?.list ?? [];
  const total = monitors.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const handleRecheck = async (row: NsMonitorRow) => {
    setError(null); setNotice(null);
    try {
      const result = await recheck.mutateAsync(row.domain_name);
      const status = STATUS_LABEL[result.status]?.label ?? result.status;
      setNotice(row.domain_name + ' 检测完成：' + status + '（当前 NS：' + (result.current_ns ?? []).join(', ') + '）');
      invalidate();
    } catch (err) { setError(err instanceof Error ? err.message : '检测失败'); }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setError(null);
    try { await remove.mutateAsync(pendingDelete.id); setPendingDelete(null); }
    catch (err) { setError(err instanceof Error ? err.message : '删除失败'); }
  };

  return (
    <Card>
      <CardContent className="space-y-3 pt-phi-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">NS 监控</p>
            <p className="text-xs text-muted-foreground">定期比对域名的 NS 记录与期望值，异常时推送告警；共 {total} 条</p>
          </div>
          <Button size="sm" onClick={() => setEditor({ mode: 'create' })}>
            <Plus className="h-4 w-4" /> 新增监控
          </Button>
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

        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-8" placeholder="搜索域名" value={keywordInput} onChange={(event) => setKeywordInput(event.target.value)} aria-label="搜索 NS 监控" />
          </div>
          <Button variant="outline" size="sm" onClick={() => void monitors.refetch()} disabled={monitors.isFetching}>
            <RefreshCw className={monitors.isFetching ? 'animate-spin' : undefined} /> 刷新
          </Button>
        </div>

        {monitors.isError ? (
          <div className="space-y-2 py-8 text-center">
            <p className="text-sm text-destructive">{monitors.error instanceof Error ? monitors.error.message : '加载失败'}</p>
            <Button variant="outline" size="sm" onClick={() => void monitors.refetch()}>重试</Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-44">域名</TableHead>
                <TableHead className="min-w-56">期望 NS</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>告警</TableHead>
                <TableHead>最近检测</TableHead>
                <TableHead>启用</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {monitors.isLoading ? (
                Array.from({ length: 5 }, (_, index) => (
                  <TableRow key={index}><TableCell colSpan={7}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                ))
              ) : rows.length === 0 ? (
                <TableEmpty colSpan={7}>{keyword ? '没有匹配的监控项' : '还没有 NS 监控，点击「新增监控」开始'}</TableEmpty>
              ) : rows.map((row) => {
                // 从未检测过时不要展示后端默认的 ok：last_check_at 为空即「未检测」
                const status = !row.last_check_at
                  ? { label: '未检测', variant: 'secondary' as const }
                  : (STATUS_LABEL[row.status ?? ''] ?? { label: row.status ?? '未知', variant: 'secondary' as const });
                return (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">{row.domain_name}</TableCell>
                    <TableCell className="max-w-[22rem] whitespace-normal break-all font-mono text-xs text-muted-foreground">{(row.expected_ns || '').split(/[,;\s]+/).filter(Boolean).join(' · ')}</TableCell>
                    <TableCell><Badge variant={status.variant}>{status.label}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.alert_count ? row.alert_count + ' 次' : '—'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.last_check_at ? formatRelative(row.last_check_at) : '—'}</TableCell>
                    <TableCell>
                      <Switch
                        checked={Boolean(row.enabled)}
                        aria-label={'启用 ' + row.domain_name}
                        onCheckedChange={(checked) => { void toggle.mutateAsync({ id: row.id, enabled: checked }).then(invalidate); }}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => void handleRecheck(row)} disabled={recheck.isPending}>
                          {recheck.isPending ? <Loader2 className="animate-spin" /> : <Radar className="h-4 w-4" />}检测
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setEditor({ mode: 'edit', row })}>编辑</Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:bg-destructive/10"
                          aria-label={'删除 ' + row.domain_name}
                          onClick={() => setPendingDelete(row)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        <Pagination
          page={page}
          pageSize={pageSize}
          pageSizes={PAGE_SIZES}
          total={total}
          totalPages={totalPages}
          isFetching={monitors.isFetching}
          onPageChange={setPage}
          onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
        />
      </CardContent>

      {editor && (
        <NsEditorDialog
          mode={editor.mode}
          row={editor.mode === 'edit' ? editor.row : undefined}
          onClose={() => setEditor(null)}
          onSaved={() => { invalidate(); setEditor(null); setNotice('监控项已保存'); }}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除 NS 监控"
        description={<>确认停止监控 <span className="font-medium text-foreground">{pendingDelete?.domain_name}</span>？历史告警记录会保留。</>}
        confirmLabel="确认删除"
        pending={remove.isPending}
        onConfirm={() => void handleDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </Card>
  );
}

function NsEditorDialog({ mode, row, onClose, onSaved }: {
  mode: 'create' | 'edit';
  row?: NsMonitorRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [domainName, setDomainName] = useState(row?.domain_name ?? '');
  const [expectedNs, setExpectedNs] = useState(row?.expected_ns ?? '');
  const [enabled, setEnabled] = useState(row ? Boolean(row.enabled) : true);
  const [notifyEmail, setNotifyEmail] = useState(row ? Boolean(row.notify_email) : true);
  const [notifyChannels, setNotifyChannels] = useState(row ? Boolean(row.notify_channels) : false);
  const [pending, setPending] = useState(false);
  // 表单错误必须显示在弹窗**内部**：页面级错误横幅会被遮罩挡住，用户看不到为什么保存失败
  const [formError, setFormError] = useState<string | null>(null);

  const domains = useQuery({ queryKey: ['ns-available-domains'], queryFn: listAvailableDomains, staleTime: 60_000, enabled: mode === 'create' });

  const resolve = useMutation({ mutationFn: (domain: string) => resolveNs(domain) });

  const options = useMemo(() => domains.data ?? [], [domains.data]);

  const autoFill = async () => {
    if (!domainName.trim()) { setFormError('请先选择域名'); return; }
    try {
      const result = await resolve.mutateAsync(domainName.trim());
      const recommended = result.recommendedNs.length > 0 ? result.recommendedNs : result.nsRecords;
      setExpectedNs(recommended.join(','));
      if (result.isPoisoned) setFormError('检测到 NS 可能被污染，已填入推荐值，请人工确认');
    } catch (err) { setFormError(err instanceof Error ? err.message : '解析 NS 失败'); }
  };

  const submit = async () => {
    setFormError(null);
    if (!domainName.trim()) { setFormError('请选择域名'); return; }
    if (!expectedNs.trim()) { setFormError('请填写期望 NS（可点「自动填充」）'); return; }
    setPending(true);
    try {
      if (mode === 'create') {
        await addNsMonitor({
          domain_name: domainName.trim(),
          expected_ns: expectedNs.trim(),
          enabled,
          notify_email: notifyEmail,
          notify_channels: notifyChannels,
        });
      } else if (row) {
        await updateNsMonitor(row.id, { expected_ns: expectedNs.trim(), enabled });
      }
      onSaved();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="w-[min(94vw,34rem)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" />{mode === 'create' ? '新增 NS 监控' : '编辑 NS 监控'}</DialogTitle>
          <DialogDescription>期望 NS 可手动填写，也可按当前解析自动填充并经人工确认。</DialogDescription>
        </DialogHeader>

        {formError && (
          <div role="alert" className={alertVariants('error', 'mb-1 flex items-center gap-2')}>
            <AlertTriangle className="h-4 w-4" /> {formError}
          </div>
        )}

        <div className="space-y-3">
          {mode === 'create' ? (
            <div className="space-y-1.5">
              <Label htmlFor="ns-domain">域名</Label>
              {options.length > 0 ? (
                <Select value={domainName} onValueChange={setDomainName}>
                  <SelectTrigger id="ns-domain"><SelectValue placeholder="选择域名" /></SelectTrigger>
                  <SelectContent>
                    {options.map((item) => <SelectItem key={item.id} value={item.name}>{item.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : (
                <Input id="ns-domain" value={domainName} onChange={(event) => setDomainName(event.target.value)} placeholder="example.com" />
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>域名</Label>
              <Input value={domainName} disabled />
            </div>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="ns-expected">期望 NS（多个用逗号分隔）</Label>
              <Button type="button" variant="ghost" size="sm" onClick={() => void autoFill()} disabled={resolve.isPending}>
                {resolve.isPending ? <Loader2 className="animate-spin" /> : <Wand2 className="h-4 w-4" />}自动填充
              </Button>
            </div>
            <Input id="ns-expected" value={expectedNs} onChange={(event) => setExpectedNs(event.target.value)} placeholder="ns1.example.com,ns2.example.com" />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
            <span className="text-sm">启用监控</span>
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="启用监控" />
          </div>

          {mode === 'create' && (
            <>
              <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                <span className="text-sm">邮件告警</span>
                <Switch checked={notifyEmail} onCheckedChange={setNotifyEmail} aria-label="邮件告警" />
              </div>
              <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                <span className="text-sm">通知渠道告警</span>
                <Switch checked={notifyChannels} onCheckedChange={setNotifyChannels} aria-label="通知渠道告警" />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" onClick={() => void submit()} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
