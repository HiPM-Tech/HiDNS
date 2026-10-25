import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Activity, Database, Globe, KeyRound, Info, Network, Server, Workflow } from 'lucide-react';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '../../ui';
import { cn } from '../../ui/cn';
import { systemApi, formatUptime } from './api';
import { SystemSecurityTab } from './security-tab';
import { SystemAccessTab } from './access-tab';
import { SystemNetworkTab } from './network-tab';
import { SystemWorkflowTab } from './workflow-tab';
import { SystemNotificationsTab } from './notifications-tab';

export type SystemTab = 'overview' | 'database' | 'security' | 'access' | 'network' | 'notifications' | 'workflow';

const TABS: Array<{ key: SystemTab; label: string; to: string; icon: typeof Info }> = [
  { key: 'overview', label: '概述', to: '/dash/system', icon: Info },
  { key: 'database', label: '数据库', to: '/dash/system/database', icon: Database },
  { key: 'security', label: '安全', to: '/dash/system/security', icon: KeyRound },
  { key: 'access', label: '访问', to: '/dash/system/access', icon: Globe },
  { key: 'network', label: '网络', to: '/dash/system/network', icon: Network },
  { key: 'notifications', label: '通知', to: '/dash/system/notifications', icon: Activity },
  { key: 'workflow', label: '工作流', to: '/dash/system/workflow', icon: Workflow },
];

export function SystemPage({ activeTab }: { activeTab: SystemTab }) {
  return (
    <div className="space-y-phi-6">
      <div>
        <h2 className="text-heading font-semibold">系统管理</h2>
        <p className="text-xs text-muted-foreground">运行状态、数据库、网络与安全配置</p>
      </div>

      <nav className="flex flex-wrap gap-1 border-b border-border pb-2" aria-label="系统管理标签页">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const active = tab.key === activeTab;
          return (
            <Link
              key={tab.key}
              to={tab.to}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
                active ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-accent',
              )}
              aria-current={active ? 'page' : undefined}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {tab.label}
            </Link>
          );
        })}
      </nav>

      {activeTab === 'overview' && <OverviewPanel />}
      {activeTab === 'database' && <DatabasePanel />}
      {activeTab === 'security' && <SystemSecurityTab />}
      {activeTab === 'access' && <SystemAccessTab />}
      {activeTab === 'network' && <SystemNetworkTab />}
      {activeTab === 'notifications' && <SystemNotificationsTab />}
      {activeTab === 'workflow' && <SystemWorkflowTab />}
    </div>
  );
}

function OverviewPanel() {
  const info = useQuery({ queryKey: ['system-info'], queryFn: systemApi.info, staleTime: 60_000 });
  const version = useQuery({ queryKey: ['system-version'], queryFn: systemApi.version, staleTime: 30_000 });

  return (
    <div className="grid gap-phi-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Server className="h-4 w-4" /> 运行状态</CardTitle>
          <CardDescription>当前实例的健康与部署信息</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {info.isLoading || version.isLoading ? (
            <div className="space-y-2">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-6" />)}</div>
          ) : info.isError || version.isError ? (
            <p className="text-destructive">{errorMessage(info.error ?? version.error)}</p>
          ) : (
            <>
              <Row label="服务状态" value={<Badge variant="success">运行中</Badge>} />
              <Row label="数据库连接" value={<Badge variant={(version.data?.nodeStatus?.dbConnected ?? version.data?.dbConnected) ? 'success' : 'destructive'}>{(version.data?.nodeStatus?.dbConnected ?? version.data?.dbConnected) ? '已连接' : '不可达'}</Badge>} />
              <Row label="部署模式" value={version.data?.deployMode ?? '—'} />
              <Row label="已运行" value={formatUptime(version.data?.nodeStatus?.uptime ?? version.data?.uptime)} />
              <Row label="日志级别" value={version.data?.logLevel ?? '—'} />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Info className="h-4 w-4" /> 版本信息</CardTitle>
          <CardDescription>前后端同源构建，版本号取自 server/package.json</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {info.isLoading ? (
            <Skeleton className="h-16" />
          ) : (
            <>
              <Row label="系统版本" value={info.data?.version ?? '—'} />
              <Row label="服务端版本" value={info.data?.serverVersion ?? '—'} />
              <Row label="Node" value={version.data?.nodeVersion ?? '—'} />
              <Row label="时区" value={info.data?.timezone ?? '—'} />
              {info.data?.isCIBuild && <Badge variant="warning">CI 构建</Badge>}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DatabasePanel() {
  const info = useQuery({ queryKey: ['system-info'], queryFn: systemApi.info, staleTime: 60_000 });
  const database = info.data?.database;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Database className="h-4 w-4" /> 数据库信息</CardTitle>
        <CardDescription>连接参数与驱动版本；修改配置请使用安装向导或环境变量</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {info.isLoading ? (
          <div className="space-y-2">{Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-6" />)}</div>
        ) : info.isError ? (
          <p className="text-destructive">{info.error instanceof Error ? info.error.message : '读取失败'}</p>
        ) : (
          <>
            <Row label="数据库类型" value={database?.type ?? '—'} />
            <Row label="数据库版本" value={database?.version ?? '—'} />
            <Row label="驱动版本" value={database?.driverVersion ?? '—'} />
            <p className="rounded-md border border-warning-200 bg-warning-50 px-3 py-2 text-xs text-warning-700 dark:border-warning-900 dark:bg-warning-900/30 dark:text-warning-300">
              修改数据库配置会重建连接；生产环境请在维护窗口操作，并确认已备份 data 目录。
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '读取失败';
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 py-1.5 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}
