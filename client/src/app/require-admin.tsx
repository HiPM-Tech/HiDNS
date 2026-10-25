import { Navigate, Outlet } from 'react-router-dom';
import { isAdminUser, useSession } from '../features/session/use-session';

/**
 * 管理员路由守卫（新会话源的唯一判定）。
 * 旧 components/ProtectedRoute 的 AdminRoute 依赖旧 AuthContext，
 * 与新壳的 useSession 形成两套权限口径（评审 P1）；管理页统一走这里。
 */
export function RequireAdmin() {
  const { user, isLoading } = useSession();
  if (isLoading) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (!isAdminUser(user)) return <Navigate to="/dash" replace />;
  return <Outlet />;
}
