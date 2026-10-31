import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from '../features/session/use-session';
import { resolveReturnTo } from '../features/auth/return-to';

/**
 * 已登录用户不该看到登录表单。
 *
 * - isLoading：占位，不渲染表单——否则会先闪一下登录页再跳走，观感更差
 * - 有会话：SPA 跳转到 return_to（仅站内相对路径）或 /dash；replace 避免回退键又弹回登录页
 * - 无会话 / 会话校验失败（5xx、网络）：照常渲染登录页，不把故障误判成「已登录」
 *
 * 与 ProtectedShell 共用 ['session'] 查询缓存，跳转时不会再打一次 /auth/me。
 */
export function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const { user, isLoading } = useSession();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
          正在校验登录状态…
        </div>
      </div>
    );
  }

  if (user) return <Navigate to={resolveReturnTo(location.search)} replace />;

  return <>{children}</>;
}
