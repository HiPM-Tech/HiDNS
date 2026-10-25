import { Navigate, Outlet } from 'react-router-dom';
import { AppShell } from './app-shell';
import { RealtimeProvider } from './realtime';
import { useSession } from '../features/session/use-session';
import { Button } from '../ui';

/** /dash/* 的统一外壳：校验会话 → 渲染新 Shell → 内容区由子路由提供 */
export function ProtectedShell() {
  const { user, isLoading, isError, error, refetch } = useSession();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30">
        <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
          正在校验登录状态…
        </div>
      </div>
    );
  }
  if (isError) {
    // 服务端异常（5xx/网络）≠ 未登录：给出可重试提示，避免把故障误判成掉登录
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
        <div className="w-full max-w-sm space-y-3 rounded-lg border border-border bg-card p-5 text-center">
          <p className="text-sm font-medium">无法校验登录状态</p>
          <p className="text-xs text-muted-foreground">
            {error instanceof Error ? error.message : '服务端暂时不可用，请稍后重试'}
          </p>
          <Button size="sm" onClick={() => void refetch()}>重试</Button>
        </div>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return (
    // 实时连接只在已登录区域建立：未登录时后端会拒绝 WS 握手，避免无意义的重连风暴
    <RealtimeProvider>
      <AppShell user={user}>
        <Outlet />
      </AppShell>
    </RealtimeProvider>
  );
}
