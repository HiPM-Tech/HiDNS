import { useEffect, useState } from 'react';
import { humanizeError } from '../../lib/error-message';
import { alertVariants } from '../../ui/alert';
import { AlertTriangle, CalendarClock, Loader2, Plus, RefreshCcw, Search, Trash2 } from 'lucide-react';
import {
  Button, Card, CardContent, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, Input, Label, Pagination, Select, SelectContent, SelectItem, SelectTrigger,
  SelectValue, Skeleton, Switch, Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow,
} from '../../ui';
import { formatDate, formatRelative } from '../../lib/format';
import { useAccounts, useProviders } from '../accounts/use-accounts';
import { filterAccountsByProviderCapability } from '../accounts/provider-capabilities';
import { providerLabel } from '../accounts/provider-labels';
import { daysLeft, isRenewableEnabled, type RenewableDomainRow, type RenewableQuery } from './renewal-api';
import { useAddRenewable, useDeleteRenewable, useProviderDomains, useRenewDomain, useRenewableDomains, useToggleRenewable } from './use-renewal';

const EMPTY_ACCOUNTS: never[] = [];

export function DomainRenewalTab() {
  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [accountId, setAccountId] = useState('all');
  const [status, setStatus] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [addOpen, setAddOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<RenewableDomainRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => { setKeyword(keywordInput.trim()); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [keywordInput]);

  const query: RenewableQuery = {
    page,
    pageSize,
    keyword: keyword || undefined,
    account_id: accountId === 'all' ? undefined : Number(accountId),
    status,
  };

  const accounts = useAccounts({});
  const providers = useProviders();
  const domains = useRenewableDomains(query);
  const toggle = useToggleRenewable();
  const remove = useDeleteRenewable();
  const renew = useRenewDomain();

  const rows = domains.data?.list ?? [];
  const total = domains.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const allAccounts = (accounts.data ?? EMPTY_ACCOUNTS) as Array<{ id: number; name: string; type: string }>;
  // 续期页只展示「支持续期」的提供商账户（DNS 解析账户不一定能续期）
  const accountOptions = filterAccountsByProviderCapability(allAccounts, providers.data, 'renewal');

  const handleRenew = async (row: RenewableDomainRow) => {
    setError(null); setNotice(null);
    try {
      await renew.mutateAsync(row.id);
      setError(null);
      setNotice('续期请求已提交，结果以调度器执行情况为准');
    } catch (err) { setError(humanizeError(err, '续期失败')); }
  };

  const handleToggle = async (row: RenewableDomainRow) => {
    setError(null);
    try { await toggle.mutateAsync({ id: row.id, enabled: !isRenewableEnabled(row) }); }
    catch (err) { setError(humanizeError(err, '操作失败')); }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setError(null);
    try { await remove.mutateAsync(pendingDelete.id); setPendingDelete(null); }
    catch (err) { setError(humanizeError(err, '删除失败')); }
  };

  return (
    <Card>
      <CardContent className="space-y-3 pt-phi-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">域名续期</p>
            <p className="text-xs text-muted-foreground">
              到期前自动检查并续期；共 {total} 条可续期域名
            </p>
          </div>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" /> 添加域名
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

        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-8" placeholder="搜索域名" value={keywordInput} onChange={(event) => setKeywordInput(event.target.value)} aria-label="搜索续期域名" />
          </div>
          <Select value={accountId} onValueChange={(value) => { setAccountId(value); setPage(1); }}>
            <SelectTrigger className="w-44" aria-label="按账户筛选"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部账户</SelectItem>
              {accountOptions.map((account) => (
                <SelectItem key={account.id} value={String(account.id)}>
                  {account.name} · {providerLabel(account.type)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={status} onValueChange={(value) => { setStatus(value as typeof status); setPage(1); }}>
            <SelectTrigger className="w-32" aria-label="按状态筛选"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="enabled">已启用</SelectItem>
              <SelectItem value="disabled">已停用</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {domains.isError ? (
          <div className="space-y-2 py-8 text-center">
            <p className="text-sm text-destructive">{domains.error instanceof Error ? domains.error.message : '加载失败'}</p>
            <Button variant="outline" size="sm" onClick={() => void domains.refetch()}>重试</Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-48">域名</TableHead>
                <TableHead>账户</TableHead>
                <TableHead>到期</TableHead>
                <TableHead>剩余</TableHead>
                <TableHead>自动续期</TableHead>
                <TableHead>最近续期</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {domains.isLoading ? (
                Array.from({ length: 5 }, (_, index) => (
                  <TableRow key={index}><TableCell colSpan={7}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                ))
              ) : rows.length === 0 ? (
                <TableEmpty colSpan={7}>还没有可续期域名，点击「添加域名」从提供商导入</TableEmpty>
              ) : rows.map((row) => {
                const remaining = daysLeft(row.expires_at);
                return (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.account_name ?? '—'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.expires_at ? formatDate(row.expires_at) : '—'}</TableCell>
                    <TableCell>
                      {remaining === null ? <span className="text-xs text-muted-foreground">—</span> : (
                        <span className={remaining <= 7 ? 'text-xs font-medium text-destructive' : remaining <= 30 ? 'text-xs text-warning-600 dark:text-warning-400' : 'text-xs text-muted-foreground'}>
                          {remaining < 0 ? '已过期 ' + Math.abs(remaining) + ' 天' : remaining + ' 天'}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={isRenewableEnabled(row)}
                        aria-label={'自动续期 ' + row.name}
                        onCheckedChange={() => void handleToggle(row)}
                      />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.last_renewed_at ? formatRelative(row.last_renewed_at) : '从未'}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleRenew(row)}
                          disabled={renew.isPending || !isRenewableEnabled(row)}
                          title={isRenewableEnabled(row) ? '立即续期' : '自动续期已停用，请先开启'}
                        >
                          {renew.isPending ? <Loader2 className="animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                          {renew.isPending ? '续期中…' : '续期'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:bg-destructive/10"
                          aria-label={'移除 ' + row.name}
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
          total={total}
          totalPages={totalPages}
          isFetching={domains.isFetching}
          onPageChange={setPage}
          onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
        />
      </CardContent>

      <AddRenewableDialog
        open={addOpen}
        accounts={accountOptions}
        onClose={() => setAddOpen(false)}
        onError={setError}
        onDone={(count) => { setNotice('已添加 ' + count + ' 个域名'); void domains.refetch(); }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="移除可续期域名"
        description={<>确认不再自动续期 <span className="font-medium text-foreground">{pendingDelete?.name}</span>？域名本身不受影响。</>}
        confirmLabel="确认移除"
        pending={remove.isPending}
        onConfirm={() => void handleDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </Card>
  );
}

function AddRenewableDialog({ open, accounts, onClose, onError, onDone }: {
  open: boolean;
  accounts: Array<{ id: number; name: string; type: string }>;
  onClose: () => void;
  onError: (message: string) => void;
  onDone: (count: number) => void;
}) {
  const [accountId, setAccountId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const providerDomains = useProviderDomains(accountId ? Number(accountId) : null);
  const add = useAddRenewable();

  const options = providerDomains.data ?? [];
  const account = accounts.find((item) => String(item.id) === accountId);

  const submit = async () => {
    if (!accountId) { onError('请选择账户'); return; }
    const picked = options.filter((item) => selected.includes(item.name));
    if (picked.length === 0) { onError('请至少选择一个域名'); return; }
    const results = await add.mutateAsync({
      accountId: Number(accountId),
      providerType: undefined,
      domains: picked,
    });
    const okCount = results.filter((item) => item.ok).length;
    if (okCount === 0) {
      onError(results[0]?.error ?? '添加失败');
      return;
    }
    onDone(okCount);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="w-[min(94vw,36rem)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><CalendarClock className="h-4 w-4" />添加可续期域名</DialogTitle>
          <DialogDescription>从提供商拉取域名列表并选择；已添加过的域名会返回错误但不影响其余条目。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="renewal-account">账户</Label>
            <Select value={accountId} onValueChange={(value) => { setAccountId(value); setSelected([]); }}>
              <SelectTrigger id="renewal-account"><SelectValue placeholder="选择账户" /></SelectTrigger>
              <SelectContent>
                {accounts.map((item) => (
                  <SelectItem key={item.id} value={String(item.id)}>
                    {item.name} · {providerLabel(item.type)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="max-h-52 overflow-y-auto rounded-md border border-border p-2">
            {!accountId ? (
              <p className="py-6 text-center text-xs text-muted-foreground">请先选择账户</p>
            ) : providerDomains.isLoading ? (
              <Skeleton className="h-16" />
            ) : options.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">该账户没有可用域名</p>
            ) : options.map((domain) => (
              <label key={domain.name} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                  checked={selected.includes(domain.name)}
                  onChange={() => setSelected((prev) => prev.includes(domain.name) ? prev.filter((item) => item !== domain.name) : [...prev, domain.name])}
                />
                <span className="min-w-0 flex-1 truncate">{domain.name}</span>
                {domain.expires_at && <span className="text-xs text-muted-foreground">{formatDate(domain.expires_at)}</span>}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">已选 {selected.length} 个{account ? ' · ' + account.name : ''}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" onClick={() => void submit()} disabled={add.isPending}>
            {add.isPending && <Loader2 className="animate-spin" />}添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
