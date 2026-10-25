import { useMemo } from 'react';
import { AlertTriangle, ArrowUpRight, Clock, Globe2, RefreshCw, Server, Users } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '../../ui';
import { useDashboard } from './use-dashboard';
import type { DashboardLog } from './api';
import { daysUntil, formatDate, formatRelative } from '../../lib/format';

function StatCard({ icon: Icon, label, value, hint }: { icon: typeof Globe2; label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-4 w-4" aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-2xl font-semibold leading-tight tracking-tight">{value}</p>
          {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function LogRow({ log }: { log: DashboardLog }) {
  return (
    <li className="flex items-center gap-3 py-2 text-sm">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{log.action}</span>
        {log.domain ? <span className="text-muted-foreground"> · {log.domain}</span> : null}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{formatRelative(log.created_at)}</span>
    </li>
  );
}

export function DashboardPage() {
  const { data, isLoading, isError, error, refetch, isFetching } = useDashboard();

  const expiring = useMemo(() => {
    const rows = (data?.domains ?? [])
      .map((domain) => ({ domain, days: daysUntil(domain.expires_at) }))
      .filter((row): row is { domain: typeof row.domain; days: number } => row.days !== null && row.days <= 30)
      .sort((a, b) => a.days - b.days);
    return rows.slice(0, 6);
  }, [data]);

  const providerStats = useMemo(() => {
    const counts = new Map<string, number>();
    for (const account of data?.accounts ?? []) {
      counts.set(account.type, (counts.get(account.type) ?? 0) + 1);
    }
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0) || 1;
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([type, count]) => ({ type, count, percent: Math.round((count / total) * 100) }));
  }, [data]);

  const recordTotal = useMemo(
    () => (data?.domains ?? []).reduce((sum, domain) => sum + (domain.record_count ?? 0), 0),
    [data],
  );
  if (isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-4 w-4" /> 仪表盘加载失败
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{error instanceof Error ? error.message : '请稍后重试'}</p>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>重试</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-phi-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-heading font-semibold">运行概览</h2>
          <p className="text-xs text-muted-foreground">域名、账户与近期操作的实时快照</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw className={isFetching ? 'animate-spin' : undefined} /> 刷新
        </Button>
      </div>

      <div className="grid gap-phi-6 sm:grid-cols-2 xl:grid-cols-4">
        {isLoading ? (
          Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-[92px]" />)
        ) : (
          <>
            <StatCard icon={Globe2} label="域名总数" value={String(data?.domainTotal ?? 0)} hint={`记录数 ${recordTotal}`} />
            <StatCard icon={Server} label="DNS 账户" value={String(data?.accounts.length ?? 0)} hint={`${providerStats.length} 个提供商`} />
            <StatCard icon={Users} label="用户" value={data?.users ? String(data.users.length) : '—'} hint={data?.users ? '含管理员' : '仅管理员可见'} />
            <StatCard icon={Clock} label="24 小时操作" value={data?.logs ? String(data.last24h) : '—'} hint={data?.logs ? `共 ${data.logs.length} 条近期记录` : '仅管理员可见'} />
          </>
        )}
      </div>

      <div className="grid gap-phi-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>即将到期</CardTitle>
            <span className="text-xs text-muted-foreground">30 天内</span>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-9" />)}</div>
            ) : expiring.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">近 30 天没有到期域名</p>
            ) : (
              <ul className="divide-y divide-border">
                {expiring.map(({ domain, days }) => (
                  <li key={domain.id} className="flex items-center gap-3 py-2.5 text-sm">
                    <Globe2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-medium">{domain.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatDate(domain.expires_at)}</span>
                    <span className={days <= 7 ? 'shrink-0 text-xs font-medium text-destructive' : 'shrink-0 text-xs text-warning-600 dark:text-warning-400'}>
                      {days < 0 ? `已过期 ${Math.abs(days)} 天` : `${days} 天`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>提供商分布</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {isLoading ? (
              <div className="space-y-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-7" />)}</div>
            ) : providerStats.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">还没有 DNS 账户</p>
            ) : (
              providerStats.map((row) => (
                <div key={row.type} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium">{row.type}</span>
                    <span className="text-muted-foreground">{row.count}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${row.percent}%` }} />
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>最近操作</CardTitle>
          <a href="/dash/audit" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
            查看全部 <ArrowUpRight className="h-3 w-3" />
          </a>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-8" />)}</div>
          ) : !data?.logs ? (
            <p className="py-6 text-center text-sm text-muted-foreground">仅管理员可查看操作日志</p>
          ) : data.logs.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">暂无操作记录</p>
          ) : (
            <ul className="divide-y divide-border">
              {data.logs.slice(0, 8).map((log) => <LogRow key={log.id} log={log} />)}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
