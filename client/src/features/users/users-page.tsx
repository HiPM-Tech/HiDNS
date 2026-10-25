import { useEffect, useMemo, useState } from 'react';
import { alertVariants } from '../../ui/alert';
import { AlertTriangle, Loader2, Pencil, Plus, RefreshCw, Search, ShieldCheck, Trash2, UserCog } from 'lucide-react';
import {
  Badge, Button, Card, CardContent, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Skeleton, Switch, Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow,
} from '../../ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate } from '../../lib/format';
import { useSession } from '../session/use-session';
import {
  assignableRoles, isActive, roleLabel, roleLevel, ROLE_ADMIN, ROLE_SUPER, ROLE_USER, usersApi,
  type CreateUserPayload, type UpdateUserPayload, type UserRow,
} from './api';
import { useCreateUser, useDeleteUser, useUpdateUser, useUsers } from './use-users';

const USERNAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export function UsersPage() {
  const { user: me } = useSession();
  const users = useUsers();
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();

  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [dialog, setDialog] = useState<{ mode: 'create' } | { mode: 'edit'; user: UserRow } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<UserRow | null>(null);
  const [twoFactorFor, setTwoFactorFor] = useState<UserRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setKeyword(keywordInput.trim().toLowerCase()), 300);
    return () => clearTimeout(timer);
  }, [keywordInput]);

  const myLevel = roleLevel((me ?? { role: ROLE_USER }) as UserRow);
  const rows = useMemo(() => {
    const list = users.data ?? [];
    if (!keyword) return list;
    return list.filter((user) =>
      user.username.toLowerCase().includes(keyword)
      || (user.nickname ?? '').toLowerCase().includes(keyword)
      || (user.email ?? '').toLowerCase().includes(keyword));
  }, [users.data, keyword]);

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setError(null);
    try {
      await deleteUser.mutateAsync(pendingDelete.id);
      setPendingDelete(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    }
  };

  const toggleStatus = async (user: UserRow) => {
    setError(null);
    try {
      await updateUser.mutateAsync({ id: user.id, payload: { status: isActive(user) ? 0 : 1 } });
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    }
  };

  /** 与服务端口径一致：超管不可改；同级或更高角色不可被更低角色修改 */
  const canModify = (user: UserRow): boolean => {
    const level = roleLevel(user);
    if (level >= ROLE_SUPER) return false;
    if (myLevel >= ROLE_SUPER) return true;
    return level < myLevel;
  };

  return (
    <div className="space-y-phi-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-heading font-semibold">用户</h2>
          <p className="text-xs text-muted-foreground">
            {users.isLoading ? '加载中…' : '共 ' + (users.data?.length ?? 0) + ' 个用户'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void users.refetch()} disabled={users.isFetching}>
            <RefreshCw className={users.isFetching ? 'animate-spin' : undefined} /> 刷新
          </Button>
          <Button size="sm" onClick={() => setDialog({ mode: 'create' })}>
            <Plus className="h-4 w-4" /> 新增用户
          </Button>
        </div>
      </div>

      {error && (
        <div role="alert" className={alertVariants('error', 'flex items-center gap-2')}>
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="relative sm:max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="搜索用户名、昵称或邮箱"
              value={keywordInput}
              onChange={(event) => setKeywordInput(event.target.value)}
              aria-label="搜索用户"
            />
          </div>

          {users.isError ? (
            <div className="space-y-2 py-8 text-center">
              <p className="text-sm text-destructive">{users.error instanceof Error ? users.error.message : '加载失败'}</p>
              <Button variant="outline" size="sm" onClick={() => void users.refetch()}>重试</Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-48">用户</TableHead>
                  <TableHead>角色</TableHead>
                  <TableHead>邮箱</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.isLoading ? (
                  Array.from({ length: 5 }, (_, index) => (
                    <TableRow key={index}><TableCell colSpan={6}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                  ))
                ) : rows.length === 0 ? (
                  <TableEmpty colSpan={6}>{keyword ? '没有匹配的用户' : '还没有用户'}</TableEmpty>
                ) : rows.map((user) => {
                  const level = roleLevel(user);
                  const modifiable = canModify(user);
                  return (
                    <TableRow key={user.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                            {(user.nickname || user.username).slice(0, 1).toUpperCase()}
                          </span>
                          <div className="min-w-0">
                            <p className="flex items-center gap-1.5 truncate font-medium">
                              {user.nickname || user.username}
                              {user.id === me?.id && <Badge variant="outline">本人</Badge>}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">@{user.username}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={level >= ROLE_SUPER ? 'warning' : level >= ROLE_ADMIN ? 'default' : 'secondary'}>
                          {roleLabel(level)}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[18rem] truncate text-xs text-muted-foreground" title={user.email || undefined}>{user.email || '—'}</TableCell>
                      <TableCell>
                        {isActive(user) ? <Badge variant="success">正常</Badge> : <Badge variant="secondary">已停用</Badge>}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{user.created_at ? formatDate(user.created_at) : '—'}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={!modifiable || updateUser.isPending}
                            onClick={() => void toggleStatus(user)}
                          >
                            {isActive(user) ? '停用' : '启用'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={!modifiable}
                            onClick={() => setTwoFactorFor(user)}
                          >
                            二次验证
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={'编辑 ' + user.username}
                            disabled={!modifiable}
                            onClick={() => setDialog({ mode: 'edit', user })}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:bg-destructive/10"
                            aria-label={'删除 ' + user.username}
                            disabled={!modifiable}
                            onClick={() => setPendingDelete(user)}
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
        </CardContent>
      </Card>

      {dialog && (
        <UserDialog
          mode={dialog.mode}
          user={dialog.mode === 'edit' ? dialog.user : undefined}
          myLevel={myLevel}
          pending={createUser.isPending || updateUser.isPending}
          onClose={() => setDialog(null)}
          onError={setError}
          onCreate={async (payload) => {
            try {
              await createUser.mutateAsync(payload);
              setDialog(null);
            } catch (err) {
              setError(err instanceof Error ? err.message : '创建失败');
            }
          }}
          onUpdate={async (id, payload) => {
            try {
              await updateUser.mutateAsync({ id, payload });
              setDialog(null);
            } catch (err) {
              setError(err instanceof Error ? err.message : '保存失败');
            }
          }}
        />
      )}

      {twoFactorFor && (
        <TwoFactorDialog user={twoFactorFor} onClose={() => setTwoFactorFor(null)} onError={setError} />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除用户"
        description={<>确认删除 <span className="font-medium text-foreground">{pendingDelete?.username}</span>？该用户的 API 令牌与域名授权会一并失效。</>}
        confirmLabel="确认删除"
        pending={deleteUser.isPending}
        onConfirm={() => void handleDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

function UserDialog({ mode, user, myLevel, pending, onClose, onError, onCreate, onUpdate }: {
  mode: 'create' | 'edit';
  user?: UserRow;
  myLevel: number;
  pending: boolean;
  onClose: () => void;
  onError: (message: string) => void;
  onCreate: (payload: CreateUserPayload) => Promise<void>;
  onUpdate: (id: number, payload: UpdateUserPayload) => Promise<void>;
}) {
  const roles = useMemo(() => assignableRoles(myLevel), [myLevel]);
  const [username, setUsername] = useState(user?.username ?? '');
  const [nickname, setNickname] = useState(user?.nickname ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(String(user ? roleLevel(user) : roles[0] ?? ROLE_USER));

  const submit = async () => {
    const trimmedUsername = username.trim();
    if (!trimmedUsername) { onError('请输入用户名'); return; }
    if (!USERNAME_PATTERN.test(trimmedUsername)) { onError('用户名只能包含字母、数字、下划线与短横线'); return; }
    if (mode === 'create' && password.length < 6) { onError('密码至少 6 位'); return; }
    if (mode === 'edit' && password && password.length < 6) { onError('新密码至少 6 位'); return; }

    if (mode === 'create') {
      await onCreate({
        username: trimmedUsername,
        password,
        nickname: nickname.trim() || undefined,
        email: email.trim() || undefined,
        role: Number(role),
      });
      return;
    }
    await onUpdate(user!.id, {
      nickname: nickname.trim(),
      email: email.trim(),
      ...(roles.includes(Number(role)) && Number(role) !== roleLevel(user!) ? { role: Number(role) } : {}),
      ...(password ? { password } : {}),
    });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><UserCog className="h-4 w-4" />{mode === 'create' ? '新增用户' : '编辑用户'}</DialogTitle>
          <DialogDescription>
            {mode === 'create' ? '用户名创建后不可修改；密码以 bcrypt 存储。' : '留空密码表示不修改。'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-phi-6 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="user-username">用户名</Label>
            <Input id="user-username" value={username} disabled={mode === 'edit'} onChange={(event) => setUsername(event.target.value)} placeholder="letters, numbers, _ -" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="user-nickname">昵称</Label>
            <Input id="user-nickname" value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="可选" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="user-email">邮箱</Label>
            <Input id="user-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="可选" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="user-role">角色</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger id="user-role"><SelectValue /></SelectTrigger>
              <SelectContent>
                {roles.map((level) => <SelectItem key={level} value={String(level)}>{roleLabel(level)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="user-password">{mode === 'create' ? '密码' : '重置密码（留空不修改）'}</Label>
            <Input id="user-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" onClick={() => void submit()} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}{mode === 'create' ? '创建' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 单用户的二次验证强制开关：全局策略为开时该用户必然强制，这里只控制用户级设置 */
function TwoFactorDialog({ user, onClose, onError }: {
  user: UserRow;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const requirement = useQuery({
    queryKey: ['user-2fa', user.id],
    queryFn: () => usersApi.twoFactorRequirement(user.id),
    staleTime: 30_000,
  });
  const save = useMutation({
    mutationFn: (required: boolean) => usersApi.setTwoFactorRequirement(user.id, required),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['user-2fa', user.id] }); },
  });

  const globalRequire = Boolean(requirement.data?.global2FAEnabled);
  const current = globalRequire || Boolean(requirement.data?.configuredRequire2FA);

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" />二次验证 · {user.username}</DialogTitle>
          <DialogDescription>
            {globalRequire
              ? '全局策略已强制所有用户启用二次验证，此处的用户级设置不再生效。'
              : '开启后该用户下次登录必须完成二次验证。'}
          </DialogDescription>
        </DialogHeader>
        {requirement.isLoading ? (
          <Skeleton className="h-10" />
        ) : requirement.isError ? (
          <p className="text-sm text-destructive">{requirement.error instanceof Error ? requirement.error.message : '读取失败'}</p>
        ) : (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
            <div>
              <p className="text-sm font-medium">强制该用户启用二次验证</p>
              <p className="text-xs text-muted-foreground">{globalRequire ? '由全局策略决定' : '当前：' + (current ? '已强制' : '未强制')}</p>
            </div>
            <Switch
              checked={current}
              disabled={globalRequire || save.isPending}
              aria-label="强制该用户启用二次验证"
              onCheckedChange={(checked) => {
                save.mutate(checked, { onError: (err) => onError(err instanceof Error ? err.message : '保存失败') });
              }}
            />
          </div>
        )}
        <DialogFooter>
          <Button size="sm" onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
