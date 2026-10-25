import { useQuery } from '@tanstack/react-query';
import { sessionApi, type SessionUser } from './api';

/** 当前会话（/auth/me）。未登录时返回 null，不抛错。 */
export function useSession() {
  const query = useQuery<SessionUser | null>({
    queryKey: ['session'],
    queryFn: sessionApi.me,
    staleTime: 60_000,
    retry: false,
  });
  return {
    user: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * 与 utils/roles 的 normalizeRole 保持同一口径：
 * role 可能是数字（0/1/2/3）或字符串（user/admin/super_admin）。
 */
export function isAdminUser(user: SessionUser | null): boolean {
  if (!user) return false;
  const level = Number(user.role_level);
  if (Number.isFinite(level) && level >= 2) return true;
  const role = String(user.role ?? '').toLowerCase();
  if (role === 'admin' || role === 'super_admin' || role === 'superadmin') return true;
  const numericRole = Number(user.role);
  return Number.isFinite(numericRole) && numericRole >= 2;
}
