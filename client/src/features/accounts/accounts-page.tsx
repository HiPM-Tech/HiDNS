import { useEffect, useMemo, useState } from 'react';
import { isAdminUser, useSession } from '../session/use-session';
import { providerLabel } from './provider-labels';
import { alertVariants } from '../../ui/alert';
import { AlertTriangle, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import {
  Badge, Button, Card, CardContent, ConfirmDialog, Input, Select, SelectContent, SelectItem, SelectTrigger,
  SelectValue, Skeleton, Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow,
} from '../../ui';
import { AccountDialog } from './account-dialog';
import { useAccounts, useDeleteAccount, useProviders } from './use-accounts';
import { isAccountEnabled, type AccountRow } from './api';

/** 稳定引用：避免把 `?? []` 产生的新数组传给对话框导致 effect 每次渲染都重置表单 */
const EMPTY_PROVIDERS: never[] = [];

export function AccountsPage() {
  const { user } = useSession();
  const canManageAccounts = isAdminUser(user);
  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AccountRow | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AccountRow | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setKeyword(keywordInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [keywordInput]);

  const accounts = useAccounts({ keyword: keyword || undefined, type: typeFilter === 'all' ? undefined : typeFilter });
  const providers = useProviders();
  const remove = useDeleteAccount();

  const providerNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const provider of providers.data ?? []) map.set(provider.type, providerLabel(provider.type || provider.name));
    return map;
  }, [providers.data]);

  const rows = accounts.data ?? [];

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setActionError(null);
    try {
      await remove.mutateAsync(pendingDelete.id);
      setPendingDelete(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '删除失败');
    }
  };

  return (
    <div className="space-y-phi-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-heading font-semibold">DNS 账户</h2>
          <p className="text-xs text-muted-foreground">
            {accounts.isLoading ? '加载中…' : '共 ' + rows.length + ' 个账户'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void accounts.refetch()} disabled={accounts.isFetching}>
            <RefreshCw className={accounts.isFetching ? 'animate-spin' : undefined} /> 刷新
          </Button>
          {/* 账号创建是管理员动作（后端 POST /accounts 内判定 isAdmin），普通用户不显示入口 */}
          {canManageAccounts && (
            <Button size="sm" onClick={() => { setEditing(null); setDialogOpen(true); }}>
              <Plus className="h-4 w-4" /> 新增账户
            </Button>
          )}
        </div>
      </div>

      {actionError && (
        <div role="alert" className={alertVariants('error', 'flex items-center gap-2')}>
          <AlertTriangle className="h-4 w-4" /> {actionError}
        </div>
      )}

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="搜索账户名称、备注或提供商"
                value={keywordInput}
                onChange={(event) => setKeywordInput(event.target.value)}
                aria-label="搜索账户"
              />
            </div>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="w-44" aria-label="按提供商筛选"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部提供商</SelectItem>
                {(providers.data ?? []).map((provider) => (
                  <SelectItem key={provider.type} value={provider.type}>{providerLabel(provider.type || provider.name)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {accounts.isError ? (
            <div className="space-y-2 py-8 text-center">
              <p className="text-sm text-destructive">{accounts.error instanceof Error ? accounts.error.message : '加载失败'}</p>
              <Button variant="outline" size="sm" onClick={() => void accounts.refetch()}>重试</Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-48">账户</TableHead>
                  <TableHead>提供商</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="min-w-40">备注</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.isLoading ? (
                  Array.from({ length: 5 }, (_, index) => (
                    <TableRow key={index}><TableCell colSpan={5}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                  ))
                ) : rows.length === 0 ? (
                  <TableEmpty colSpan={5}>{keyword || typeFilter !== 'all' ? '没有符合条件的账户' : '还没有 DNS 账户'}</TableEmpty>
                ) : (
                  rows.map((account) => (
                    <TableRow key={account.id}>
                      <TableCell className="font-medium">{account.name}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{providerNameMap.get(account.type) ?? account.type}</Badge>
                      </TableCell>
                      <TableCell>
                        {isAccountEnabled(account)
                          ? <Badge variant="success">已启用</Badge>
                          : <Badge variant="secondary">已禁用</Badge>}
                      </TableCell>
                      <TableCell className="max-w-60 truncate text-xs text-muted-foreground">{account.remark || '—'}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="icon" aria-label={'编辑 ' + account.name} onClick={() => { setEditing(account); setDialogOpen(true); }}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:bg-destructive/10"
                            aria-label={'删除 ' + account.name}
                            onClick={() => setPendingDelete(account)}
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
        </CardContent>
      </Card>
      {dialogOpen && (
        <AccountDialog
          key={editing ? 'edit-' + editing.id : 'create'}
                open
                onOpenChange={(open) => { setDialogOpen(open); if (!open) setEditing(null); }}
                providers={providers.data ?? EMPTY_PROVIDERS}
                account={editing}
              />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除账户"
        description={
          <>
            确认删除 <span className="font-medium text-foreground">{pendingDelete?.name}</span>？
            该账户下已托管的域名将无法继续同步解析记录。
          </>
        }
        confirmLabel="确认删除"
        pending={remove.isPending}
        onConfirm={() => void handleDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
