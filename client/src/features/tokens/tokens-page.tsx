import { useState } from 'react';
import { alertVariants } from '../../ui/alert';
import { AlertTriangle, Check, Copy, KeyRound, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  Badge, Button, Card, CardContent, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, Skeleton, Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow,
} from '../../ui';
import { formatDate, formatRelative } from '../../lib/format';
import { TokenDialog } from './token-dialog';
import { useDeleteToken, useTokens, useToggleToken } from './use-tokens';
import { isTokenActive, type CreatedToken, type TokenRow } from './api';
import { useSession } from '../session/use-session';

function roleLabel(level?: number): string {
  if (level === 3) return '超级管理员';
  if (level === 2) return '管理员';
  if (level === 1) return '普通用户';
  return level === undefined ? '—' : '只读';
}

function formatWindow(token: TokenRow): string {
  if (!token.start_time && !token.end_time) return '长期有效';
  const start = token.start_time ? formatDate(token.start_time) : '立即';
  const end = token.end_time ? formatDate(token.end_time) : '不限';
  return start + ' → ' + end;
}

export function TokensPage() {
  const { user } = useSession();
  const tokens = useTokens();
  const toggle = useToggleToken();
  const remove = useDeleteToken();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TokenRow | null>(null);
  const [editing, setEditing] = useState<TokenRow | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const rows = tokens.data ?? [];
  const currentRoleLevel = Number(user?.role_level ?? 0);

  const handleToggle = async (token: TokenRow) => {
    setActionError(null);
    try {
      await toggle.mutateAsync({ id: token.id, active: !isTokenActive(token) });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '操作失败');
    }
  };

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

  const copyToken = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setActionError('复制失败，请手动选择文本复制');
    }
  };

  return (
    <div className="space-y-phi-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-heading font-semibold">API 令牌</h2>
          <p className="text-xs text-muted-foreground">
            {tokens.isLoading ? '加载中…' : '共 ' + rows.length + ' 个令牌'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void tokens.refetch()} disabled={tokens.isFetching}>
            <RefreshCw className={tokens.isFetching ? 'animate-spin' : undefined} /> 刷新
          </Button>
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4" /> 新增令牌
          </Button>
        </div>
      </div>

      {actionError && (
        <div role="alert" className={alertVariants('error', 'flex items-center gap-2')}>
          <AlertTriangle className="h-4 w-4" /> {actionError}
        </div>
      )}

      <Card>
        <CardContent className="p-4">
          {tokens.isError ? (
            <div className="space-y-2 py-8 text-center">
              <p className="text-sm text-destructive">{tokens.error instanceof Error ? tokens.error.message : '加载失败'}</p>
              <Button variant="outline" size="sm" onClick={() => void tokens.refetch()}>重试</Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-40">名称</TableHead>
                  <TableHead>域名</TableHead>
                  <TableHead>服务</TableHead>
                  <TableHead>角色上限</TableHead>
                  <TableHead>有效期</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>最近使用</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.isLoading ? (
                  Array.from({ length: 4 }, (_, index) => (
                    <TableRow key={index}><TableCell colSpan={8}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                  ))
                ) : rows.length === 0 ? (
                  <TableEmpty colSpan={8}>还没有 API 令牌</TableEmpty>
                ) : (
                  rows.map((token) => (
                    <TableRow key={token.id}>
                      <TableCell>
                        <div className="flex min-w-0 max-w-[18rem] items-center gap-2">
                          <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="truncate font-medium" title={token.name}>{token.name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {Array.isArray(token.allowed_domains) ? token.allowed_domains.length + ' 个' : '—'}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {(token.allowed_services ?? []).slice(0, 3).map((service) => (
                            <Badge key={service} variant="secondary">{service}</Badge>
                          ))}
                          {(token.allowed_services ?? []).length > 3 && (
                            <span className="text-xs text-muted-foreground">+{(token.allowed_services ?? []).length - 3}</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{roleLabel(token.max_role)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatWindow(token)}</TableCell>
                      <TableCell>
                        {isTokenActive(token)
                          ? <Badge variant="success">已启用</Badge>
                          : <Badge variant="secondary">已停用</Badge>}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {token.last_used_at ? formatRelative(token.last_used_at) : '从未使用'}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={'编辑 ' + token.name}
                            onClick={() => setEditing(token)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => void handleToggle(token)} disabled={toggle.isPending}>
                            {isTokenActive(token) ? '停用' : '启用'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:bg-destructive/10"
                            aria-label={'删除 ' + token.name}
                            onClick={() => setPendingDelete(token)}
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
      {(dialogOpen || editing) && (
        <TokenDialog
          key={editing ? 'token-edit-' + editing.id : 'token-create'}
          open
          token={editing}
          onOpenChange={(next) => {
            if (!next) { setDialogOpen(false); setEditing(null); }
          }}
          currentRoleLevel={currentRoleLevel}
          onCreated={(value) => { setCreated(value); setCopied(false); }}
          onSaved={() => setEditing(null)}
        />
      )}

      <Dialog open={created !== null} onOpenChange={(open) => { if (!open) setCreated(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>令牌已创建</DialogTitle>
            <DialogDescription>
              这是唯一一次展示明文令牌，关闭后无法再次查看；请立即保存到安全位置。
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 p-2">
            <code className="min-w-0 flex-1 break-all font-mono text-xs">{created?.token}</code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => created && void copyToken(created.token)}
              aria-label="复制令牌"
            >
              {copied ? <Check className="h-4 w-4 text-success-600" /> : <Copy className="h-4 w-4" />}
              {copied ? '已复制' : '复制'}
            </Button>
          </div>
          <DialogFooter>
            <Button size="sm" onClick={() => setCreated(null)}>我已保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除令牌"
        description={
          <>
            确认删除 <span className="font-medium text-foreground">{pendingDelete?.name}</span>？
            使用该令牌的自动化任务会立即失去访问权限。
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
