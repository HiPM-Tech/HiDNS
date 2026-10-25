import { useEffect, useMemo, useState } from 'react';
import { alertVariants } from '../../ui/alert';
import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronDown, ChevronRight, FolderTree, Globe2, Pencil, Pin, PinOff, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import {
  Badge, Button, Card, CardContent, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, Input, Label, Pagination, Select, SelectContent, SelectItem,
  SelectTrigger, SelectValue, Skeleton, Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow,
} from '../../ui';
import { daysUntil, formatDate, formatNumber } from '../../lib/format';
import { useDeleteDomain, useDomainAccounts, useDomains, useToggleDomain, useUpdateDomainRemark } from './use-domains';
import { isDomainEnabled, isGroupHeader, type DomainQuery, type DomainRow } from './api';
import { AddDomainDialog } from './add-domain-dialog';
import { isAdminUser, useSession } from '../session/use-session';

const PINNED_KEY = 'hidns.domains.pinned';
/** 分组方式：virtual = 无条件按可注册域造组；strict = 只有父域已添加才成组 */
const GROUP_MODE_KEY = 'hidns.domains.group.mode';
type GroupMode = 'virtual' | 'strict';

function readGroupMode(): GroupMode {
  try {
    return localStorage.getItem(GROUP_MODE_KEY) === 'strict' ? 'strict' : 'virtual';
  } catch {
    return 'virtual';
  }
}

/** 置顶列表存在本地：它是「我的视图偏好」而不是服务端资源 */
function readPinned(): number[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PINNED_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((item): item is number => typeof item === 'number') : [];
  } catch {
    return [];
  }
}

function writePinned(ids: number[]): void {
  localStorage.setItem(PINNED_KEY, JSON.stringify(ids));
}

export function DomainsPage() {
  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [accountId, setAccountId] = useState<string>('all');
  const [status, setStatus] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [pendingDelete, setPendingDelete] = useState<DomainRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // 置顶：本地保存域名 id 列表，服务端按 pinned_domains 参数排前面
  const [pinned, setPinned] = useState<number[]>(() => readPinned());
  const [remarkFor, setRemarkFor] = useState<DomainRow | null>(null);
  const updateRemark = useUpdateDomainRemark();
  const [actionError, setActionError] = useState<string | null>(null);
  // 分组展示（默认开）：服务端 grouped=true 会插入 _type='group_header' 的虚拟组头
  const [grouping, setGrouping] = useState(true);
  const [groupMode, setGroupMode] = useState<GroupMode>(() => readGroupMode());
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(() => new Set());
  // 新增域名要求对账号有管理权（超级管理员 / 自己创建账号的管理员），普通用户不显示入口
  const { user } = useSession();
  const canCreateDomain = isAdminUser(user);

  // 搜索输入防抖：300ms 后进入查询参数并回到第一页
  useEffect(() => {
    const timer = setTimeout(() => {
      setKeyword(keywordInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [keywordInput]);

  const query: DomainQuery = {
    page,
    pageSize,
    keyword: keyword || undefined,
    account_id: accountId === 'all' ? undefined : Number(accountId),
    domain_status: status,
    pinned_domains: pinned.join(','),
    grouped: grouping,
    virtual_groups: grouping && groupMode === 'virtual',
  };

  const { data, isLoading, isError, error, refetch, isFetching } = useDomains(query);
  const accountsQuery = useDomainAccounts();
  const toggleDomain = useToggleDomain();
  const togglePin = (id: number) => {
    const next = pinned.includes(id) ? pinned.filter((item) => item !== id) : [...pinned, id];
    setPinned(next);
    writePinned(next);
  };
  const deleteDomain = useDeleteDomain();

  const accountMap = useMemo(() => {
    const map = new Map<number, { name: string; type: string }>();
    for (const account of accountsQuery.data ?? []) map.set(account.id, { name: account.name, type: account.type });
    return map;
  }, [accountsQuery.data]);

  const rows = data?.list ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, data?.totalPages ?? 1);

  const handleToggle = async (domain: DomainRow) => {
    setActionError(null);
    try {
      await toggleDomain.mutateAsync({ id: domain.id, enabled: !isDomainEnabled(domain) });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '操作失败');
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    setActionError(null);
    try {
      await deleteDomain.mutateAsync(pendingDelete.id);
      setPendingDelete(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '删除失败');
    }
  };

  return (
    <div className="space-y-phi-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-heading font-semibold">域名</h2>
          <p className="text-xs text-muted-foreground">
            {isLoading ? '加载中…' : `共 ${formatNumber(total)} 个域名`}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw className={isFetching ? 'animate-spin' : undefined} /> 刷新
        </Button>
        {/* 新增域名要求对账号有管理权：普通用户不显示入口（后端会 404 账号不可见） */}
        {canCreateDomain && (
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" /> 新增域名
          </Button>
        )}
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
                placeholder="搜索域名或备注"
                value={keywordInput}
                onChange={(event) => setKeywordInput(event.target.value)}
                aria-label="搜索域名"
              />
            </div>
            <div className="flex gap-2">
              <Button
                variant={grouping ? 'secondary' : 'outline'}
                size="sm"
                aria-pressed={grouping}
                onClick={() => { setGrouping((prev) => !prev); setPage(1); setExpandedGroups(new Set()); }}
              >
                <FolderTree className="h-4 w-4" /> {grouping ? '已分组' : '分组'}
              </Button>
              {grouping && (
                <Select
                  value={groupMode}
                  onValueChange={(value) => {
                    const next = value as GroupMode;
                    setGroupMode(next);
                    try { localStorage.setItem(GROUP_MODE_KEY, next); } catch { /* 隐私模式忽略 */ }
                    setExpandedGroups(new Set());
                    setPage(1);
                  }}
                >
                  <SelectTrigger className="w-40" aria-label="分组方式">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="virtual">总是分组</SelectItem>
                    <SelectItem value="strict">仅父域存在</SelectItem>
                  </SelectContent>
                </Select>
              )}
              <Select value={accountId} onValueChange={(value) => { setAccountId(value); setPage(1); }}>
                <SelectTrigger className="w-44" aria-label="按账户筛选">
                  <SelectValue placeholder="全部账户" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部账户</SelectItem>
                  {(accountsQuery.data ?? []).map((account) => (
                    <SelectItem key={account.id} value={String(account.id)}>
                      {account.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={status} onValueChange={(value) => { setStatus(value as typeof status); setPage(1); }}>
                <SelectTrigger className="w-32" aria-label="按状态筛选">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部状态</SelectItem>
                  <SelectItem value="enabled">已启用</SelectItem>
                  <SelectItem value="disabled">已禁用</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {isError ? (
            <div className="space-y-2 py-8 text-center">
              <p className="text-sm text-destructive">{error instanceof Error ? error.message : '加载失败'}</p>
              <Button variant="outline" size="sm" onClick={() => void refetch()}>重试</Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-56">域名</TableHead>
                  <TableHead>账户</TableHead>
                  <TableHead className="text-right">记录数</TableHead>
                  <TableHead>到期</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 6 }, (_, index) => (
                    <TableRow key={index}>
                      <TableCell colSpan={6}><Skeleton className="h-6 w-full" /></TableCell>
                    </TableRow>
                  ))
                ) : rows.length === 0 ? (
                  <TableEmpty colSpan={6}>
                    {keyword || accountId !== 'all' || status !== 'all' ? '没有符合条件的域名' : '还没有添加域名'}
                  </TableEmpty>
                ) : (
                  rows.map((item) => {
                    if (isGroupHeader(item)) {
                      const open = expandedGroups.has(item.id);
                      return (
                        <TableRow key={'group-' + item.id} className="bg-muted/40 hover:bg-muted/40">
                          <TableCell colSpan={6}>
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 text-left"
                              aria-expanded={open}
                              onClick={() => setExpandedGroups((prev) => {
                                const next = new Set(prev);
                                if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
                                return next;
                              })}
                            >
                              {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                              <FolderTree className="h-4 w-4 text-muted-foreground" aria-hidden />
                              <span className="font-medium">{item.groupName}</span>
                              <Badge variant="secondary">{item.childIds.length} 个子域</Badge>
                              {item.parentPresent === false && (
                                <Badge
                                  variant="warning"
                                  title={'父域 ' + item.groupName + ' 尚未添加到系统：组内只有已添加的子域，父域自身的到期/WHOIS 信息不可用'}
                                >
                                  父域未添加
                                </Badge>
                              )}
                            </button>
                          </TableCell>
                        </TableRow>
                      );
                    }
                    const domain = item;
                    // 折叠态下隐藏子域行（父域自身作为组头成员也一并隐藏）
                    if (domain._groupParentId != null && !expandedGroups.has(domain._groupParentId)) return null;
                    const canWrite = domain.can_write !== false;
                    const account = accountMap.get(domain.account_id);
                    const enabled = isDomainEnabled(domain);
                    const remaining = daysUntil(domain.expires_at);
                    return (
                      <TableRow key={domain.id}>
                        <TableCell>
                          <div className={"flex items-center gap-2" + (domain._groupParentId != null ? ' pl-phi-7' : '')}>
                            <Globe2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                            <div className="min-w-0">
                              <Link
                                to={`/dash/domains/${domain.id}/records`}
                                className="truncate font-medium underline-offset-4 hover:underline"
                              >
                                {domain.name}
                              </Link>
                              {domain.remark ? <p className="max-w-[26rem] truncate text-xs text-muted-foreground" title={domain.remark}>{domain.remark}</p> : null}
                              {domain.whois_status ? (
                                <Badge variant={domain.whois_status === 'active' ? 'success' : 'warning'} className="mt-1">
                                  WHOIS：{domain.whois_status}
                                </Badge>
                              ) : null}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          {account ? (
                            <div className="flex items-center gap-1.5">
                              <Badge variant="secondary">{account.type}</Badge>
                              <span className="max-w-32 truncate text-xs text-muted-foreground">{account.name}</span>
                            </div>
                          ) : <span className="text-xs text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(domain.record_count)}</TableCell>
                        <TableCell>
                          <span className="text-xs text-muted-foreground">{formatDate(domain.expires_at)}</span>
                          {remaining !== null && remaining <= 30 && (
                            <span className={remaining <= 7 ? 'ml-1 text-xs font-medium text-destructive' : 'ml-1 text-xs text-warning-600 dark:text-warning-400'}>
                              {remaining < 0 ? `已过期 ${Math.abs(remaining)} 天` : `${remaining} 天`}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          {enabled
                            ? <Badge variant="success">已启用</Badge>
                            : <Badge variant="secondary">已禁用</Badge>}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button asChild variant="ghost" size="sm">
                              <Link to={`/dash/domains/${domain.id}/records`}>记录</Link>
                            </Button>
                            {canWrite && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => void handleToggle(domain)}
                                disabled={toggleDomain.isPending}
                              >
                                {enabled ? '禁用' : '启用'}
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={(pinned.includes(domain.id) ? '取消置顶 ' : '置顶 ') + domain.name}
                              onClick={() => togglePin(domain.id)}
                            >
                              {pinned.includes(domain.id) ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                            </Button>
                            {canWrite && (
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={'编辑备注 ' + domain.name}
                                onClick={() => setRemarkFor(domain)}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                            )}
                            {canWrite && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="text-destructive hover:bg-destructive/10"
                                aria-label={`删除 ${domain.name}`}
                                onClick={() => setPendingDelete(domain)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                            {!canWrite && <Badge variant="secondary">只读</Badge>}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          )}

          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            totalPages={totalPages}
            isFetching={isFetching}
            onPageChange={setPage}
            onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
          />
        </CardContent>
      </Card>

      <AddDomainDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={() => { void refetch(); void accountsQuery.refetch(); }}
      />

      {remarkFor && (
        <RemarkDialog
          domain={remarkFor}
          pending={updateRemark.isPending}
          onClose={() => setRemarkFor(null)}
          onSubmit={async (remark) => {
            try {
              await updateRemark.mutateAsync({ id: remarkFor.id, remark });
              setRemarkFor(null);
            } catch (err) {
              setActionError(err instanceof Error ? err.message : '保存备注失败');
            }
          }}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除域名"
        description={
          <>
            确认从 HiDNS 移除 <span className="font-medium text-foreground">{pendingDelete?.name}</span>？
            此操作只解除托管，不会删除 DNS 提供商侧的解析记录。
          </>
        }
        confirmLabel="确认删除"
        pending={deleteDomain.isPending}
        onConfirm={() => void handleDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

/** 备注编辑：域名列表里最常用的轻量操作，单字段不值得单开页面 */
function RemarkDialog({ domain, pending, onClose, onSubmit }: {
  domain: DomainRow;
  pending: boolean;
  onClose: () => void;
  onSubmit: (remark: string) => Promise<void>;
}) {
  const [remark, setRemark] = useState(domain.remark ?? '');
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑备注 · {domain.name}</DialogTitle>
          <DialogDescription>备注只影响列表展示与搜索，不会写入 DNS 提供商。</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="domain-remark">备注</Label>
          <Input id="domain-remark" value={remark} onChange={(event) => setRemark(event.target.value)} placeholder="例如：生产环境主域" />
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button size="sm" disabled={pending} onClick={() => void onSubmit(remark.trim())}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

