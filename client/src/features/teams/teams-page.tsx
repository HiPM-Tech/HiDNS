import { useState } from 'react';
import { humanizeError } from '../../lib/error-message';
import { alertVariants } from '../../ui/alert';
import { AlertTriangle, KeyRound, Loader2, Plus, Trash2, UserPlus, Users } from 'lucide-react';
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, Dialog,
  DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Select,
  SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton,
} from '../../ui';
import { cn } from '../../ui/cn';
import {
  canManageTeam, memberLabel, memberUserId, permissionLabel, type PermissionInput, type PermissionRow, type TeamRow,
} from './api';
import { useSession } from '../session/use-session';
import {
  useAddMember, useAddPermission, useDeleteTeam, useDomainOptions, useMemberPermissions, useRemoveMember,
  useRemovePermission, useSaveTeam, useTeamMembers, useTeamPermissions, useTeams, useUpdateMemberRole, useUserOptions,
} from './use-teams';

const EMPTY_TEAMS: TeamRow[] = [];

export function TeamsPage() {
  const { user } = useSession();
  const teams = useTeams();
  const [selectedIdState, setSelectedId] = useState<number | null>(null);
  const [teamDialog, setTeamDialog] = useState<'create' | 'edit' | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TeamRow | null>(null);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [permissionDialog, setPermissionDialog] = useState<{ userId: number | null; label: string } | null>(null);
  const [memberPermissionsFor, setMemberPermissionsFor] = useState<{ userId: number; label: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const rows = teams.data ?? EMPTY_TEAMS;

  // 选中项派生：列表变化（删除/新增）时自动落回第一个，无需 effect 回写
  const selectedId = selectedIdState != null && rows.some((team) => team.id === selectedIdState)
    ? selectedIdState
    : rows[0]?.id ?? null;

  const selected = rows.find((team) => team.id === selectedId) ?? null;
  // 与服务端口径一致：只有超管 / 团队 admin / 创建者能改，其余成员只读（否则点了必然 403）
  const isSuperUser = Number(user?.role_level ?? 0) >= 3 || String(user?.role ?? '').toLowerCase().includes('super');
  const manageable = canManageTeam(selected, Number(user?.id ?? 0), isSuperUser);
  const members = useTeamMembers(selectedId);
  const permissions = useTeamPermissions(selectedId);
  const deleteTeam = useDeleteTeam();
  const removeMember = useRemoveMember(selectedId);
  const updateRole = useUpdateMemberRole(selectedId);
  const removePermission = useRemovePermission(selectedId, null);

  const handleDeleteTeam = async () => {
    if (!pendingDelete) return;
    setActionError(null);
    try {
      await deleteTeam.mutateAsync(pendingDelete.id);
      setPendingDelete(null);
    } catch (err) {
      setActionError(humanizeError(err, '删除失败'));
    }
  };

  return (
    <div className="space-y-phi-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-heading font-semibold">团队</h2>
          <p className="text-xs text-muted-foreground">团队、成员与域名权限</p>
        </div>
        <Button size="sm" onClick={() => setTeamDialog('create')}>
          <Plus className="h-4 w-4" /> 新增团队
        </Button>
      </div>

      {actionError && (
        <div role="alert" className={alertVariants('error', 'flex items-center gap-2')}>
          <AlertTriangle className="h-4 w-4" /> {actionError}
        </div>
      )}

      <div className="grid gap-phi-6 lg:grid-cols-[18rem_1fr]">
        <Card>
          <CardHeader><CardTitle className="text-sm">团队列表</CardTitle></CardHeader>
          <CardContent className="space-y-1 p-2">
            {teams.isLoading ? (
              <div className="space-y-2 p-2">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-10" />)}</div>
            ) : rows.length === 0 ? (
              <p className="p-4 text-center text-sm text-muted-foreground">还没有团队</p>
            ) : (
              rows.map((team) => (
                <button
                  key={team.id}
                  type="button"
                  onClick={() => setSelectedId(team.id)}
                  className={cn(
                    'w-full rounded-md px-3 py-2 text-left text-sm transition-colors',
                    team.id === selectedId ? 'bg-primary/10 text-primary' : 'hover:bg-accent',
                  )}
                >
                  <span className="block truncate font-medium">{team.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{team.description || '—'}</span>
                </button>
              ))
            )}
          </CardContent>
        </Card>

        <div className="space-y-3">
          {!selected ? (
            <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">选择左侧团队查看详情</CardContent></Card>
          ) : (
            <>
              <Card>
                <CardHeader className="flex-row items-start justify-between gap-2">
                  <div>
                    <CardTitle className="flex items-center gap-2"><Users className="h-4 w-4" /> {selected.name}</CardTitle>
                    <CardDescription>{selected.description || '暂无描述'}</CardDescription>
                  </div>
                  <div className="flex items-center gap-1">
                    {!manageable && <Badge variant="secondary">只读</Badge>}
                    <Button variant="outline" size="sm" disabled={!manageable} onClick={() => setTeamDialog('edit')}>编辑</Button>
                    <Button variant="ghost" size="sm" className="text-destructive" disabled={!manageable} onClick={() => setPendingDelete(selected)}>删除</Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-muted-foreground">成员（{members.data?.length ?? 0}）</p>
                    <Button size="sm" variant="outline" disabled={!manageable} onClick={() => setAddMemberOpen(true)}>
                      <UserPlus className="h-4 w-4" /> 添加成员
                    </Button>
                  </div>
                  {members.isLoading ? (
                    <Skeleton className="h-16" />
                  ) : (members.data ?? []).length === 0 ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">还没有成员</p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {(members.data ?? []).map((member) => {
                        const userId = memberUserId(member);
                        return (
                          <li key={userId} className="flex items-center gap-2 py-2 text-sm">
                            <span className="min-w-0 flex-1 truncate">{memberLabel(member)}</span>
                            <Select
                              disabled={!manageable}
                              value={member.role === 'admin' ? 'admin' : 'member'}
                              onValueChange={async (role) => {
                                if (role === (member.role ?? 'member')) return;
                                try { await updateRole.mutateAsync({ userId, role: role as 'admin' | 'member' }); }
                                catch (err) { setActionError(humanizeError(err, '角色变更失败')); }
                              }}
                            >
                              <SelectTrigger className="h-8 w-24" aria-label={`${memberLabel(member)} 的角色`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="admin">管理员</SelectItem>
                                <SelectItem value="member">成员</SelectItem>
                              </SelectContent>
                            </Select>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={!manageable}
                              onClick={() => setMemberPermissionsFor({ userId, label: memberLabel(member) })}
                            >
                              权限
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-destructive hover:bg-destructive/10"
                              aria-label={`移除 ${memberLabel(member)}`}
                              disabled={!manageable}
                              onClick={async () => {
                                try { await removeMember.mutateAsync(userId); } catch (err) { setActionError(humanizeError(err, '移除失败')); }
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex-row items-start justify-between gap-2">
                  <div>
                    <CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" /> 团队域名权限</CardTitle>
                    <CardDescription>团队成员对这些域名拥有对应权限</CardDescription>
                  </div>
                  <Button size="sm" variant="outline" disabled={!manageable} onClick={() => setPermissionDialog({ userId: null, label: '团队' })}>
                    <Plus className="h-4 w-4" /> 添加授权
                  </Button>
                </CardHeader>
                <CardContent>
                  <PermissionList
                    loading={permissions.isLoading}
                    rows={permissions.data ?? []}
                    onRemove={async (id) => {
                      try { await removePermission.mutateAsync(id); } catch (err) { setActionError(humanizeError(err, '移除失败')); }
                    }}
                  />
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>

      <TeamDialog
        key={teamDialog === 'edit' ? 'edit-' + (selected?.id ?? 'none') : 'create'}
        mode={teamDialog}
        team={selected}
        onClose={() => setTeamDialog(null)}
        onError={setActionError}
      />

      <AddMemberDialog
        open={addMemberOpen}
        teamId={selectedId}
        existing={new Set((members.data ?? []).map(memberUserId))}
        onClose={() => setAddMemberOpen(false)}
        onError={setActionError}
      />

      <PermissionDialog
        open={permissionDialog !== null}
        teamId={selectedId}
        userId={permissionDialog?.userId ?? null}
        scopeLabel={permissionDialog?.label ?? ''}
        onClose={() => setPermissionDialog(null)}
        onError={setActionError}
      />

      {memberPermissionsFor && selectedId != null && (
        <MemberPermissionsDialog
          teamId={selectedId}
          userId={memberPermissionsFor.userId}
          label={memberPermissionsFor.label}
          onClose={() => setMemberPermissionsFor(null)}
          onError={setActionError}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除团队"
        description={<>确认删除 <span className="font-medium text-foreground">{pendingDelete?.name}</span>？团队成员与授权会一并移除（域名本身不受影响）。</>}
        confirmLabel="确认删除"
        pending={deleteTeam.isPending}
        onConfirm={() => void handleDeleteTeam()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

function PermissionList({ loading, rows, onRemove }: {
  loading: boolean;
  rows: PermissionRow[];
  onRemove: (id: number) => void;
}) {
  if (loading) return <Skeleton className="h-16" />;
  if (rows.length === 0) return <p className="py-4 text-center text-sm text-muted-foreground">还没有授权</p>;
  return (
    <ul className="divide-y divide-border">
      {rows.map((row) => (
        <li key={row.id} className="flex items-center gap-2 py-2 text-sm">
          <span className="min-w-0 flex-1 truncate">{permissionLabel(row)}</span>
          {row.sub ? <Badge variant="outline">{row.sub}</Badge> : null}
          <Badge variant={row.permission === 'write' ? 'warning' : 'secondary'}>
            {row.permission === 'write' ? '读写' : '只读'}
          </Badge>
          <Button variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10" aria-label="移除授权" onClick={() => onRemove(row.id)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </li>
      ))}
    </ul>
  );
}

function TeamDialog({ mode, team, onClose, onError }: {
  mode: 'create' | 'edit' | null;
  team: TeamRow | null;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const save = useSaveTeam();
  // 初值直接取自 props：父级按 mode/team 给 key，切换时组件重挂载，无需 effect 回填
  const [name, setName] = useState(mode === 'edit' ? team?.name ?? '' : '');
  const [description, setDescription] = useState(mode === 'edit' ? team?.description ?? '' : '');

  const submit = async () => {
    if (!name.trim()) { onError('请输入团队名称'); return; }
    try {
      await save.mutateAsync({ id: mode === 'edit' ? team?.id : undefined, payload: { name: name.trim(), description: description.trim() } });
      onClose();
    } catch (err) {
      onError(humanizeError(err, '保存失败'));
    }
  };

  return (
    <Dialog open={mode !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === 'edit' ? '编辑团队' : '新增团队'}</DialogTitle>
          <DialogDescription>团队用于批量授权域名，成员可拥有只读或读写权限。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="team-name">名称</Label>
            <Input
              id="team-name"
              value={name}
              maxLength={50}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：运维组"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="team-desc">描述</Label>
            <Input id="team-desc" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="可选" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" onClick={() => void submit()} disabled={save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddMemberDialog({ open, teamId, existing, onClose, onError }: {
  open: boolean;
  teamId: number | null;
  existing: Set<number>;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const users = useUserOptions();
  const add = useAddMember(teamId);
  const [userId, setUserId] = useState('');


  const candidates = (users.data ?? []).filter((user) => !existing.has(user.id));

  const submit = async () => {
    if (!userId) { onError('请选择用户'); return; }
    try {
      await add.mutateAsync(Number(userId));
      onClose();
    } catch (err) {
      onError(humanizeError(err, '添加失败'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加成员</DialogTitle>
          <DialogDescription>只能添加尚未加入该团队的用户。</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="team-member">用户</Label>
          <Select value={userId} onValueChange={setUserId}>
            <SelectTrigger id="team-member"><SelectValue placeholder="选择用户" /></SelectTrigger>
            <SelectContent>
              {candidates.map((user) => (
                <SelectItem key={user.id} value={String(user.id)}>
                  {user.nickname || user.username}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {candidates.length === 0 && <p className="text-xs text-muted-foreground">没有可添加的用户</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" onClick={() => void submit()} disabled={add.isPending || candidates.length === 0}>
            {add.isPending && <Loader2 className="animate-spin" />}添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PermissionDialog({ open, teamId, userId, scopeLabel, onClose, onError }: {
  open: boolean;
  teamId: number | null;
  userId: number | null;
  scopeLabel: string;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const domains = useDomainOptions();
  const add = useAddPermission(teamId, userId);
  const [domainId, setDomainId] = useState('');
  const [permission, setPermission] = useState<'read' | 'write'>('write');
  const [sub, setSub] = useState('');


  const submit = async () => {
    if (!domainId) { onError('请选择域名'); return; }
    const payload: PermissionInput = { domain_id: Number(domainId), permission, sub: sub.trim() || undefined };
    try {
      await add.mutateAsync(payload);
      onClose();
    } catch (err) {
      onError(humanizeError(err, '添加授权失败'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加域名授权（{scopeLabel}）</DialogTitle>
          <DialogDescription>子域留空表示整域授权；填写如 <code className="rounded bg-muted px-1">www</code> 表示仅该子域。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="perm-domain">域名</Label>
            <Select value={domainId} onValueChange={setDomainId}>
              <SelectTrigger id="perm-domain"><SelectValue placeholder="选择域名" /></SelectTrigger>
              <SelectContent>
                {(domains.data ?? []).map((domain) => (
                  <SelectItem key={domain.id} value={String(domain.id)}>{domain.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-phi-6 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="perm-level">权限</Label>
              <Select value={permission} onValueChange={(value) => setPermission(value as 'read' | 'write')}>
                <SelectTrigger id="perm-level"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="read">只读</SelectItem>
                  <SelectItem value="write">读写</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="perm-sub">子域（可选）</Label>
              <Input id="perm-sub" value={sub} onChange={(event) => setSub(event.target.value)} placeholder="www" />
            </div>
          </div>
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

function MemberPermissionsDialog({ teamId, userId, label, onClose, onError }: {
  teamId: number;
  userId: number;
  label: string;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const permissions = useMemberPermissions(teamId, userId);
  const remove = useRemovePermission(teamId, userId);
  const [adding, setAdding] = useState(false);

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label} 的域名权限</DialogTitle>
          <DialogDescription>成员个人权限与团队权限叠加生效。</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <PermissionList
            loading={permissions.isLoading}
            rows={permissions.data ?? []}
            onRemove={async (id) => {
              try { await remove.mutateAsync(id); } catch (err) { onError(humanizeError(err, '移除失败')); }
            }}
          />
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" /> 添加个人授权
          </Button>
        </div>
        <DialogFooter>
          <Button size="sm" onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
      <PermissionDialog
        open={adding}
        teamId={teamId}
        userId={userId}
        scopeLabel={label}
        onClose={() => setAdding(false)}
        onError={onError}
      />
    </Dialog>
  );
}
