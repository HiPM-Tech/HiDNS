import { useState } from 'react';
import { alertVariants } from '../../ui/alert';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Copy, KeyRound, Loader2, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, Dialog, DialogContent,
  DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Select, SelectContent, SelectItem,
  SelectTrigger, SelectValue, Skeleton, Switch, Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow,
} from '../../ui';
import { cn } from '../../ui/cn';
import { formatDate, formatRelative } from '../../lib/format';
import { isAdminUser, useSession } from '../session/use-session';
import {
  describeScope, mcpApi, parseScope, serializeScope, SCOPE_LEVELS, SCOPE_MODULES,
  type McpKeyRow, type McpOAuthClientRow,
} from './api';

type Tab = 'keys' | 'clients';

export function McpPage() {
  const queryClient = useQueryClient();
  // 后端 /mcp/config 是 adminOnly：非管理员不展示可点的开关，避免「点了必 403」
  const { user } = useSession();
  const canManage = isAdminUser(user);
  const [tab, setTab] = useState<Tab>('keys');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<{ apiKey: string; description: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newSecret, setNewSecret] = useState<{ clientId: string; clientSecret: string } | null>(null);
  const [editingClient, setEditingClient] = useState<McpOAuthClientRow | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<McpKeyRow | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'key'; row: McpKeyRow } | { kind: 'client'; row: McpOAuthClientRow } | null>(null);

  // 非管理员不发 /mcp/config（adminOnly，必 403）；enabled 关掉也避免 React Query 重试三次
  const config = useQuery({ queryKey: ['mcp', 'config'], queryFn: mcpApi.globalConfig, staleTime: 30_000, enabled: canManage, retry: false });
  const keys = useQuery({ queryKey: ['mcp', 'keys'], queryFn: mcpApi.keys, staleTime: 20_000 });
  const clients = useQuery({ queryKey: ['mcp', 'clients'], queryFn: mcpApi.oauthClients, staleTime: 20_000 });

  const invalidate = (key: string[]) => { void queryClient.invalidateQueries({ queryKey: key }); };

  const toggleMcp = useMutation({
    mutationFn: (enabled: boolean) => mcpApi.setGlobalEnabled(enabled),
    onSuccess: () => invalidate(['mcp']),
  });
  const revokeKey = useMutation({ mutationFn: (id: number) => mcpApi.revokeKey(id), onSuccess: () => invalidate(['mcp', 'keys']) });
  const restoreKey = useMutation({ mutationFn: (id: number) => mcpApi.restoreKey(id), onSuccess: () => invalidate(['mcp', 'keys']) });
  const deleteKey = useMutation({ mutationFn: (id: number) => mcpApi.deleteKey(id), onSuccess: () => invalidate(['mcp', 'keys']) });
  const deleteClient = useMutation({ mutationFn: (id: string) => mcpApi.deleteOAuthClient(id), onSuccess: () => invalidate(['mcp', 'clients']) });
  const updateScope = useMutation({
    mutationFn: ({ clientId, scope }: { clientId: string; scope: string }) => mcpApi.updateOAuthScope(clientId, scope),
    onSuccess: () => invalidate(['mcp', 'clients']),
  });

  const run = async (action: () => Promise<unknown>, success: string) => {
    setError(null); setNotice(null);
    try { await action(); setNotice(success); }
    catch (err) { setError(err instanceof Error ? err.message : '操作失败'); }
  };

  return (
    <div className="space-y-phi-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-heading font-semibold">MCP</h2>
          <p className="text-xs text-muted-foreground">让 AI 客户端以受控权限访问 DNS 数据与操作</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { void keys.refetch(); void clients.refetch(); }}>
            <RefreshCw className={keys.isFetching || clients.isFetching ? 'animate-spin' : undefined} /> 刷新
          </Button>
          {tab === 'keys' ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> 新增 API 密钥</Button>
          ) : (
            <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> 新增 OAuth 客户端</Button>
          )}
        </div>
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

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> 全局开关</CardTitle>
            <CardDescription>
              {canManage
                ? '关闭后所有 MCP 客户端（含已授权）立即无法连接。'
                : '仅管理员可切换；当前为只读视图。'}
            </CardDescription>
          </div>
          {config.isLoading ? <Skeleton className="h-6 w-12" /> : (
            <Switch
              checked={Boolean(config.data?.enabled)}
              aria-label="启用 MCP 服务"
              disabled={!canManage}
              onCheckedChange={(checked) => void run(() => toggleMcp.mutateAsync(checked), checked ? 'MCP 已启用' : 'MCP 已停用')}
            />
          )}
        </CardHeader>
      </Card>

      <nav className="flex gap-1 border-b border-border pb-2" aria-label="MCP 标签页">
        {([['keys', 'API 密钥'], ['clients', 'OAuth 客户端']] as Array<[Tab, string]>).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={cn('rounded-md px-3 py-1.5 text-sm transition-colors',
              tab === value ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-accent')}
            aria-current={tab === value ? 'page' : undefined}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'keys' ? (
        <Card>
          <CardContent className="p-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-32">密钥</TableHead>
                  <TableHead>说明</TableHead>
                  <TableHead>最近使用</TableHead>
                  <TableHead>过期</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.isLoading ? (
                  Array.from({ length: 3 }, (_, index) => (
                    <TableRow key={index}><TableCell colSpan={6}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                  ))
                ) : (keys.data ?? []).length === 0 ? (
                  <TableEmpty colSpan={6}>还没有 API 密钥</TableEmpty>
                ) : (keys.data ?? []).map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-xs">{maskKey(row.api_key)}</TableCell>
                    <TableCell className="text-sm">{row.description || '—'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.last_used_at ? formatRelative(row.last_used_at) : '从未'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.expires_at ? formatDate(row.expires_at) : '永久'}</TableCell>
                    <TableCell>
                      {row.revoked_at ? <Badge variant="destructive">已撤销</Badge> : <Badge variant="success">有效</Badge>}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {row.revoked_at ? (
                          <Button variant="ghost" size="sm" onClick={() => void run(() => restoreKey.mutateAsync(row.id), '密钥已恢复')}>恢复</Button>
                        ) : (
                          <Button variant="ghost" size="sm" onClick={() => setPendingRevoke(row)}>撤销</Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:bg-destructive/10"
                          aria-label={'删除密钥 ' + row.id}
                          onClick={() => setPendingDelete({ kind: 'key', row })}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-40">应用</TableHead>
                  <TableHead className="min-w-56">权限</TableHead>
                  <TableHead>过期</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clients.isLoading ? (
                  Array.from({ length: 3 }, (_, index) => (
                    <TableRow key={index}><TableCell colSpan={5}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                  ))
                ) : (clients.data ?? []).length === 0 ? (
                  <TableEmpty colSpan={5}>还没有 OAuth 客户端</TableEmpty>
                ) : (clients.data ?? []).map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <p className="font-medium">{row.app_name}</p>
                      <p className="font-mono text-xs text-muted-foreground">{row.client_id}</p>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{describeScope(row.scope)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.expires_at ? formatDate(row.expires_at) : '永久'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.created_at ? formatDate(row.created_at) : '—'}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setEditingClient(row)}>权限</Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:bg-destructive/10"
                          aria-label={'删除客户端 ' + row.app_name}
                          onClick={() => setPendingDelete({ kind: 'client', row })}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {createOpen && tab === 'keys' && (
        <CreateKeyDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(apiKey, description) => { setCreateOpen(false); setNewKey({ apiKey, description }); invalidate(['mcp', 'keys']); }}
          onError={setError}
        />
      )}

      {createOpen && tab === 'clients' && (
        <CreateClientDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(clientId, clientSecret) => { setCreateOpen(false); setNewSecret({ clientId, clientSecret }); invalidate(['mcp', 'clients']); }}
          onError={setError}
        />
      )}

      {newKey && <SecretDialog title="API 密钥已创建" hint="仅显示一次，请立即保存" value={newKey.apiKey} onClose={() => setNewKey(null)} />}
      {newSecret && <SecretDialog title="OAuth 客户端已创建" hint="client_secret 仅显示一次" value={newSecret.clientSecret} extra={'client_id: ' + newSecret.clientId} onClose={() => setNewSecret(null)} />}

      {editingClient && (
        <ScopeDialog
          client={editingClient}
          pending={updateScope.isPending}
          onClose={() => setEditingClient(null)}
          onSubmit={async (scope) => {
            setEditingClient(null);
            await run(() => updateScope.mutateAsync({ clientId: editingClient.client_id, scope }), '权限已更新');
          }}
        />
      )}

      <ConfirmDialog
        open={pendingRevoke !== null}
        title="撤销 API 密钥"
        description="撤销后使用该密钥的 MCP 客户端会立即失联；可在列表中恢复。"
        confirmLabel="确认撤销"
        pending={revokeKey.isPending}
        onConfirm={() => { const row = pendingRevoke; setPendingRevoke(null); if (row) void run(() => revokeKey.mutateAsync(row.id), '密钥已撤销'); }}
        onCancel={() => setPendingRevoke(null)}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete?.kind === 'key' ? '删除 API 密钥' : '删除 OAuth 客户端'}
        description="删除后不可恢复，已授权的客户端会立即失效。"
        confirmLabel="确认删除"
        pending={deleteKey.isPending || deleteClient.isPending}
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (!target) return;
          if (target.kind === 'key') void run(() => deleteKey.mutateAsync(target.row.id), '密钥已删除');
          else void run(() => deleteClient.mutateAsync(target.row.client_id), '客户端已删除');
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

function maskKey(apiKey: string): string {
  if (!apiKey) return '—';
  if (apiKey.length <= 10) return apiKey;
  return apiKey.slice(0, 6) + '…' + apiKey.slice(-4);
}

function CreateKeyDialog({ onClose, onCreated, onError }: {
  onClose: () => void;
  onCreated: (apiKey: string, description: string) => void;
  onError: (message: string) => void;
}) {
  const [description, setDescription] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (!description.trim()) { onError('请输入说明，便于日后区分'); return; }
    setPending(true);
    try {
      const result = await mcpApi.createKey({ description: description.trim(), expires_at: expiresAt || null });
      const apiKey = result.api_key ?? result.keyData?.api_key ?? '';
      if (!apiKey) throw new Error('服务端未返回密钥');
      onCreated(apiKey, description.trim());
    } catch (err) {
      onError(err instanceof Error ? err.message : '创建失败');
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" />新增 API 密钥</DialogTitle>
          <DialogDescription>密钥仅在创建后显示一次；过期时间留空表示永久有效。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="key-desc">说明</Label>
            <Input id="key-desc" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="例如：Claude Desktop" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="key-expiry">过期时间（可选）</Label>
            <Input id="key-expiry" type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" onClick={() => void submit()} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateClientDialog({ onClose, onCreated, onError }: {
  onClose: () => void;
  onCreated: (clientId: string, clientSecret: string) => void;
  onError: (message: string) => void;
}) {
  const [appName, setAppName] = useState('');
  const [redirects, setRedirects] = useState('');
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (!appName.trim()) { onError('请输入应用名称'); return; }
    const uris = redirects.split('\n').map((item) => item.trim()).filter(Boolean);
    if (uris.length === 0) { onError('至少填写一个回调地址'); return; }
    setPending(true);
    try {
      const result = await mcpApi.createOAuthClient({ app_name: appName.trim(), redirect_uris: uris });
      onCreated(result.client_id, result.client_secret);
    } catch (err) {
      onError(err instanceof Error ? err.message : '创建失败');
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" />新增 OAuth 客户端</DialogTitle>
          <DialogDescription>创建后可在列表中配置模块权限；client_secret 仅显示一次。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="client-name">应用名称</Label>
            <Input id="client-name" value={appName} onChange={(event) => setAppName(event.target.value)} placeholder="例如：Claude Desktop" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="client-redirects">回调地址（每行一个）</Label>
            <textarea
              id="client-redirects"
              className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={redirects}
              onChange={(event) => setRedirects(event.target.value)}
              placeholder="http://127.0.0.1:8765/callback"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" onClick={() => void submit()} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScopeDialog({ client, pending, onClose, onSubmit }: {
  client: McpOAuthClientRow;
  pending: boolean;
  onClose: () => void;
  onSubmit: (scope: string) => Promise<void>;
}) {
  const [perms, setPerms] = useState<Record<string, string>>(() => {
    const initial = parseScope(client.scope);
    const next: Record<string, string> = {};
    for (const module of SCOPE_MODULES) next[module.key] = initial[module.key] ?? 'disabled';
    return next;
  });

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>配置权限 · {client.app_name}</DialogTitle>
          <DialogDescription>按模块授予只读或读写；禁用表示该模块不可访问。</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {SCOPE_MODULES.map((module) => (
            <div key={module.key} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <span className="text-sm">{module.label}</span>
              <Select
                value={perms[module.key] ?? 'disabled'}
                onValueChange={(value) => setPerms((prev) => ({ ...prev, [module.key]: value }))}
              >
                <SelectTrigger className="h-8 w-28" aria-label={module.label + ' 权限'}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SCOPE_LEVELS.map((level) => <SelectItem key={level.value} value={level.value}>{level.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" disabled={pending} onClick={() => void onSubmit(serializeScope(perms))}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SecretDialog({ title, hint, value, extra, onClose }: {
  title: string;
  hint: string;
  value: string;
  extra?: string;
  onClose: () => void;
}) {
  // 每次打开都是一次性凭据：直接以 value 作为「已复制」状态的归属，避免 effect 重置
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const copied = copiedValue === value;

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{hint}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {extra && <p className="font-mono text-xs text-muted-foreground">{extra}</p>}
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 p-2">
            <code className="min-w-0 flex-1 break-all font-mono text-xs">{value}</code>
            <Button
              variant="ghost"
              size="icon"
              aria-label="复制"
              onClick={() => { void navigator.clipboard.writeText(value); setCopiedValue(value); }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          {copied && <p className="text-xs text-success-600 dark:text-success-400">已复制</p>}
        </div>
        <DialogFooter>
          <Button size="sm" onClick={onClose}>我已保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
