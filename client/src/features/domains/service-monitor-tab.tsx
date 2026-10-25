import { useEffect, useState } from 'react';
import { humanizeError } from '../../lib/error-message';
import { alertVariants } from '../../ui/alert';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, AlertTriangle, Loader2, Pencil, Plus, RefreshCw, Search, ShieldCheck, Trash2 } from 'lucide-react';
import {
  Badge, Button, Card, CardContent, ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle, Input, Label, Pagination, Select, SelectContent, SelectItem, SelectTrigger,
  SelectValue, Skeleton, Switch, Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow,
} from '../../ui';
import { cn } from '../../ui/cn';
import { formatRelative } from '../../lib/format';
import {
  MONITOR_TYPE_LABEL, monitorStatus, sslDaysLeft, serviceMonitorApi,
  type AvailableDomain, type MonitorPayload, type MonitorRow, type MonitorType,
} from './service-monitor-api';

const TABS: MonitorType[] = ['ssl_certificate', 'endpoint', 'dns_failover'];

export function ServiceMonitorTab() {
  const queryClient = useQueryClient();
  const [type, setType] = useState<MonitorType>('ssl_certificate');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [editor, setEditor] = useState<{ mode: 'create' } | { mode: 'edit'; row: MonitorRow } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MonitorRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState('');
  // 300ms 防抖：每敲一个字符就发请求会把骨架屏闪成幻灯片（与 NS/续期页保持一致）
  useEffect(() => {
    const timer = setTimeout(() => { setKeyword(keywordInput.trim()); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [keywordInput]);

  const monitors = useQuery({
    queryKey: ['service-monitors', type, page, pageSize, keyword],
    queryFn: () => serviceMonitorApi.list({ page, pageSize, type, keyword: keyword || undefined }),
    staleTime: 30_000,
  });

  const invalidate = () => { void queryClient.invalidateQueries({ queryKey: ['service-monitors'] }); };

  const check = useMutation({
    mutationFn: (id: number) => serviceMonitorApi.check(id),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: (id: number) => serviceMonitorApi.remove(id), onSuccess: invalidate });

  const rows = monitors.data?.list ?? [];
  const total = monitors.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const runCheck = async (row: MonitorRow) => {
    setError(null); setNotice(null);
    try {
      await check.mutateAsync(row.id);
      setNotice(row.name + ' 检测完成');
    } catch (err) { setError(humanizeError(err, '检测失败')); }
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
            <p className="text-sm font-medium">服务监控</p>
            <p className="text-xs text-muted-foreground">SSL 证书到期、端点可用性与 DNS 故障转移；共 {total} 条</p>
          </div>
          <div className="flex flex-1 items-center justify-end gap-2 sm:max-w-xs">
            <div className="relative w-full">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="搜索名称或目标"
                aria-label="搜索监控"
                value={keywordInput}
                onChange={(event) => setKeywordInput(event.target.value)}
              />
            </div>
          </div>
          <Button size="sm" onClick={() => setEditor({ mode: 'create' })}>
            <Plus className="h-4 w-4" /> 新增监控
          </Button>
        </div>

        <nav className="flex flex-wrap gap-1 border-b border-border pb-2" aria-label="监控类型">
          {TABS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => { setType(item); setPage(1); }}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm transition-colors',
                item === type ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-accent',
              )}
              aria-current={item === type ? 'page' : undefined}
            >
              {MONITOR_TYPE_LABEL[item]}
            </button>
          ))}
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void monitors.refetch()} disabled={monitors.isFetching}>
            <RefreshCw className={monitors.isFetching ? 'animate-spin' : undefined} /> 刷新
          </Button>
        </nav>

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

        {monitors.isError ? (
          <div className="space-y-2 py-8 text-center">
            <p className="text-sm text-destructive">{monitors.error instanceof Error ? monitors.error.message : '加载失败'}</p>
            <Button variant="outline" size="sm" onClick={() => void monitors.refetch()}>重试</Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-44">名称</TableHead>
                <TableHead>目标</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>响应</TableHead>
                <TableHead>最近检测</TableHead>
                <TableHead>周期</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {monitors.isLoading ? (
                Array.from({ length: 4 }, (_, index) => (
                  <TableRow key={index}><TableCell colSpan={7}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                ))
              ) : rows.length === 0 ? (
                <TableEmpty colSpan={7}>还没有 {MONITOR_TYPE_LABEL[type]} 监控</TableEmpty>
              ) : rows.map((row) => {
                const status = monitorStatus(row);
                const days = sslDaysLeft(row);
                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <p className="font-medium">{row.name}</p>
                      {row.monitor_type === 'ssl_certificate' && days !== null && (
                        <p className={cn('text-xs', days <= 7 ? 'text-destructive' : days <= 30 ? 'text-warning-600 dark:text-warning-400' : 'text-muted-foreground')}>
                          证书剩余 {days} 天
                        </p>
                      )}
                      {row.parent_id ? <p className="text-xs text-muted-foreground">已绑定故障转移</p> : null}
                    </TableCell>
                    <TableCell className="max-w-56 truncate text-xs text-muted-foreground" title={row.target}>{row.target}</TableCell>
                    <TableCell><Badge variant={status.variant}>{status.label}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.response_time != null ? row.response_time + ' ms' : '—'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.last_check_at ? formatRelative(row.last_check_at) : '—'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.check_interval ? Math.round(row.check_interval / 60) + ' 分钟' : '—'}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => void runCheck(row)} disabled={check.isPending}>
                          {check.isPending ? <Loader2 className="animate-spin" /> : <Activity className="h-4 w-4" />}检测
                        </Button>
                        <Button variant="ghost" size="icon" aria-label={'编辑 ' + row.name} onClick={() => setEditor({ mode: 'edit', row })}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:bg-destructive/10"
                          aria-label={'删除 ' + row.name}
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
          isFetching={monitors.isFetching}
          onPageChange={setPage}
          onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
        />
      </CardContent>

      {editor && (
        <MonitorEditorDialog
          mode={editor.mode}
          type={type}
          row={editor.mode === 'edit' ? editor.row : undefined}
          onClose={() => setEditor(null)}
          onSaved={() => { invalidate(); setEditor(null); setNotice('监控已保存'); }}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除监控"
        description={<>确认删除 <span className="font-medium text-foreground">{pendingDelete?.name}</span>？历史检测记录会被清理。</>}
        confirmLabel="确认删除"
        pending={remove.isPending}
        onConfirm={() => void handleDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </Card>
  );
}

function MonitorEditorDialog({ mode, type, row, onClose, onSaved }: {
  mode: 'create' | 'edit';
  type: MonitorType;
  row?: MonitorRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const config = (row?.config ?? {}) as Record<string, unknown>;
  const [name, setName] = useState(row?.name ?? '');
  const [target, setTarget] = useState(row?.target ?? '');
  const [interval, setInterval] = useState(String(row?.check_interval ?? 300));
  const [notifyFailure, setNotifyFailure] = useState(row?.notify_on_failure ?? true);
  const [notifyRecovery, setNotifyRecovery] = useState(row?.notify_on_recovery ?? true);
  const [port, setPort] = useState(String(config.port ?? 443));
  const [warnDays, setWarnDays] = useState(String(config.warn_days_before ?? 30));
  const [protocol, setProtocol] = useState(String(config.protocol ?? 'https'));
  const [path, setPath] = useState(String(config.path ?? '/'));
  const [followRedirects, setFollowRedirects] = useState(config.followRedirects !== false);
  const [domainId, setDomainId] = useState(row?.domain_id ? String(row.domain_id) : '');
  const [recordType, setRecordType] = useState(String(config.recordType ?? 'A'));
  const [recordName, setRecordName] = useState(String(config.recordName ?? ''));
  const [recordTtl, setRecordTtl] = useState(String(config.ttl ?? 600));
  const [primaryValue, setPrimaryValue] = useState(String(config.primaryValue ?? ''));
  const [backupValues, setBackupValues] = useState(Array.isArray(config.backupValues) ? (config.backupValues as string[]).join('\n') : '');
  const [autoSwitchBack, setAutoSwitchBack] = useState(config.autoSwitchBack !== false);
  // 后端已支持、但界面此前没暴露的字段（C 端细节轮 P1）
  const [checkMethod, setCheckMethod] = useState(String(config.checkMethod ?? 'tcp'));
  const [checkPort, setCheckPort] = useState(String(config.checkPort ?? 80));
  const [checkPath, setCheckPath] = useState(String(config.checkPath ?? '/'));
  const [expectedStatus, setExpectedStatus] = useState(String(config.expectedStatus ?? 200));
  const [expectedBody, setExpectedBody] = useState(String(config.expectedBody ?? ''));
  const [enabled, setEnabled] = useState(row ? Boolean(row.enabled ?? true) : true);
  const [pending, setPending] = useState(false);
  // 校验错误必须显示在弹窗内：页面级横幅会被遮罩挡住，用户只看到「点保存没反应」
  const [formError, setFormError] = useState<string | null>(null);

  const domains = useQuery({
    queryKey: ['service-monitor-domains'],
    queryFn: serviceMonitorApi.availableDomains,
    enabled: type === 'dns_failover',
    staleTime: 60_000,
  });

  const options: AvailableDomain[] = domains.data ?? [];

  const submit = async () => {
    if (!name.trim()) { setFormError('请输入名称'); return; }
    const effectiveTarget = type === 'dns_failover'
      ? (options.find((item) => String(item.id) === domainId)?.name ?? '')
      : target.trim();
    if (!effectiveTarget) { setFormError(type === 'dns_failover' ? '请选择域名' : '请输入目标'); return; }
    if (/\s/.test(effectiveTarget)) { setFormError('目标不能包含空格'); return; }
    if (type === 'endpoint') {
      if (/^https?:\/\//i.test(effectiveTarget)) {
        try { new URL(effectiveTarget); } catch { setFormError('目标 URL 格式不正确'); return; }
      } else if (effectiveTarget.includes('/')) {
        setFormError('请填写完整 URL（含 http:// 或 https://）或只填主机名'); return;
      }
    }
    // 目标不允许带 userinfo（@ 会把后面的 host 改写掉，等于绕过 SSRF 校验）
    if (target.includes('@')) { setFormError('目标不能包含 “@”'); return; }
    const intervalNum = Number(interval);
    if (!Number.isFinite(intervalNum) || intervalNum < 30 || intervalNum > 86400) {
      setFormError('检测周期需在 30–86400 秒之间'); return;
    }
    const portNum = Number(port);
    if (type !== 'dns_failover' && (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535)) {
      setFormError('端口需在 1–65535 之间'); return;
    }
    const checkPortNum = Number(checkPort);
    if (type === 'dns_failover' && (!Number.isInteger(checkPortNum) || checkPortNum < 1 || checkPortNum > 65535)) {
      setFormError('检查端口需在 1–65535 之间'); return;
    }
    if (type === 'ssl_certificate') {
      const days = Number(warnDays);
      if (!Number.isInteger(days) || days < 1 || days > 365) { setFormError('告警天数需在 1–365 之间'); return; }
    }
    if (type === 'endpoint') {
      const code = Number(expectedStatus);
      if (!Number.isInteger(code) || code < 100 || code > 599) { setFormError('期望状态码需在 100–599 之间'); return; }
      if (!path.startsWith('/')) { setFormError('路径必须以 / 开头'); return; }
    }
    if (type === 'dns_failover' && checkMethod === 'http' && !checkPath.startsWith('/')) {
      setFormError('检查路径必须以 / 开头'); return;
    }
    setFormError(null);
    setPending(true);

    const payload: MonitorPayload = {
      name: name.trim(),
      monitor_type: type,
      target: effectiveTarget,
      check_interval: Number(interval) || 300,
      notify_on_failure: notifyFailure,
      notify_on_recovery: notifyRecovery,
      enabled,
    };

    if (type === 'ssl_certificate') {
      // 以原配置打底再覆盖已知字段：整份重建会丢 allowPrivate/line/headers 等未在表单暴露的键
      payload.config = { ...(row?.config ?? {}), port: Number(port) || 443, warn_days_before: Number(warnDays) || 30 };
    } else if (type === 'endpoint') {
      payload.config = {
        ...(row?.config ?? {}),
        protocol, port: Number(port) || 443, path: path || '/', followRedirects,
        expectedStatus: Number(expectedStatus) || 200,
        expectedBody: expectedBody.trim() || undefined,
      };
    } else {
      if (!domainId) { setPending(false); setFormError('请选择域名'); return; }
      payload.domain_id = Number(domainId);
      payload.config = {
        ...(row?.config ?? {}),
        recordType,
        recordName,
        ttl: Number(recordTtl) || 600,
        primaryValue,
        backupValues: backupValues.split('\n').map((item) => item.trim()).filter(Boolean),
        autoSwitchBack,
        checkMethod,
        checkPort: Number(checkPort) || 80,
        checkPath: checkMethod === 'http' ? (checkPath || '/') : undefined,
      };
    }

    try {
      if (mode === 'create') await serviceMonitorApi.create(payload);
      else if (row) await serviceMonitorApi.update(row.id, payload);
      onSaved();
    } catch (err) {
      setFormError(humanizeError(err, '保存失败'));
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="w-[min(94vw,36rem)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            {mode === 'create' ? '新增' : '编辑'}{MONITOR_TYPE_LABEL[type]}监控
          </DialogTitle>
          <DialogDescription>
            {type === 'ssl_certificate' && '按端口探测证书链，到期前按天数阈值告警。'}
            {type === 'endpoint' && '按周期请求端点并记录响应时间与状态码。'}
            {type === 'dns_failover' && '主值不可用时切换到备用值；切换与回切都会记录审计。'}
          </DialogDescription>
        </DialogHeader>

        {formError && (
          <div role="alert" className={alertVariants('error', 'mb-1 flex items-center gap-2')}>
            <AlertTriangle className="h-4 w-4" /> {formError}
          </div>
        )}

        <div className="grid gap-phi-6 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="monitor-name">名称</Label>
            <Input id="monitor-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：example.com 证书" />
          </div>
          {type === 'dns_failover' ? (
            <div className="space-y-1.5">
              <Label htmlFor="monitor-target-readonly">目标</Label>
              {/* 故障转移的目标就是所选域名，单独再填一次既重复又容易与域名不一致 */}
              <Input
                id="monitor-target-readonly"
                value={options.find((item) => String(item.id) === domainId)?.name ?? ''}
                readOnly
                placeholder="选择域名后自动填充"
                className="bg-muted/50"
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="monitor-target">目标</Label>
              <Input id="monitor-target" value={target} onChange={(event) => setTarget(event.target.value)} placeholder={type === 'endpoint' ? 'https://example.com/health' : 'example.com'} />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="monitor-interval">检测周期（秒）</Label>
            <Input id="monitor-interval" inputMode="numeric" value={interval} onChange={(event) => setInterval(event.target.value)} />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 sm:col-span-2">
            <span className="text-sm">启用监控</span>
            <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="启用监控" />
          </div>

          {type !== 'dns_failover' && (
            <div className="space-y-1.5">
              <Label htmlFor="monitor-port">端口</Label>
              <Input id="monitor-port" inputMode="numeric" value={port} onChange={(event) => setPort(event.target.value)} />
            </div>
          )}

          {type === 'ssl_certificate' && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="monitor-warn-days">到期前告警天数</Label>
              <Input id="monitor-warn-days" inputMode="numeric" value={warnDays} onChange={(event) => setWarnDays(event.target.value)} />
            </div>
          )}

          {type === 'endpoint' && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="monitor-protocol">协议</Label>
                <Select value={protocol} onValueChange={setProtocol}>
                  <SelectTrigger id="monitor-protocol"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="https">HTTPS</SelectItem>
                    <SelectItem value="http">HTTP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="monitor-path">路径</Label>
                <Input id="monitor-path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="monitor-expected-status">期望状态码</Label>
                <Input id="monitor-expected-status" inputMode="numeric" value={expectedStatus} onChange={(event) => setExpectedStatus(event.target.value)} placeholder="200" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="monitor-expected-body">期望响应体包含（可选）</Label>
                <Input id="monitor-expected-body" value={expectedBody} onChange={(event) => setExpectedBody(event.target.value)} placeholder="ok" />
              </div>
              <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 sm:col-span-2">
                <span className="text-sm">跟随重定向</span>
                <Switch checked={followRedirects} onCheckedChange={setFollowRedirects} aria-label="跟随重定向" />
              </div>
            </>
          )}

          {type === 'dns_failover' && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="monitor-check-method">检查方式</Label>
                <Select value={checkMethod} onValueChange={setCheckMethod}>
                  <SelectTrigger id="monitor-check-method"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tcp">TCP 端口</SelectItem>
                    <SelectItem value="http">HTTP 请求</SelectItem>
                    <SelectItem value="ping">Ping</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="monitor-check-port">检查端口</Label>
                <Input id="monitor-check-port" inputMode="numeric" value={checkPort} onChange={(event) => setCheckPort(event.target.value)} placeholder="80" />
              </div>
              {checkMethod === 'http' && (
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="monitor-check-path">检查路径</Label>
                  <Input id="monitor-check-path" value={checkPath} onChange={(event) => setCheckPath(event.target.value)} placeholder="/health" />
                </div>
              )}
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="monitor-domain">域名</Label>
                <Select value={domainId} onValueChange={setDomainId}>
                  <SelectTrigger id="monitor-domain"><SelectValue placeholder={domains.isLoading ? '加载中…' : '选择域名'} /></SelectTrigger>
                  <SelectContent>
                    {options.map((domain) => <SelectItem key={domain.id} value={String(domain.id)}>{domain.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="monitor-record-type">记录类型</Label>
                <Input id="monitor-record-type" value={recordType} onChange={(event) => setRecordType(event.target.value)} placeholder="A" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="monitor-record-name">记录名</Label>
                <Input id="monitor-record-name" value={recordName} onChange={(event) => setRecordName(event.target.value)} placeholder="@" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="monitor-ttl">TTL</Label>
                <Input id="monitor-ttl" inputMode="numeric" value={recordTtl} onChange={(event) => setRecordTtl(event.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="monitor-primary">主值</Label>
                <Input id="monitor-primary" value={primaryValue} onChange={(event) => setPrimaryValue(event.target.value)} placeholder="203.0.113.10" />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="monitor-backup">备用值（每行一个）</Label>
                <textarea
                  id="monitor-backup"
                  className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={backupValues}
                  onChange={(event) => setBackupValues(event.target.value)}
                  placeholder={'198.51.100.1\n198.51.100.2'}
                />
              </div>
              <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 sm:col-span-2">
                <span className="text-sm">主值恢复后自动切回</span>
                <Switch checked={autoSwitchBack} onCheckedChange={setAutoSwitchBack} aria-label="自动切回" />
              </div>
            </>
          )}

          <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
            <span className="text-sm">失败告警</span>
            <Switch checked={notifyFailure} onCheckedChange={setNotifyFailure} aria-label="失败告警" />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
            <span className="text-sm">恢复通知</span>
            <Switch checked={notifyRecovery} onCheckedChange={setNotifyRecovery} aria-label="恢复通知" />
          </div>
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
