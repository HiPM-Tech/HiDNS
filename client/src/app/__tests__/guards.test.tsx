import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProtectedShell } from '../protected-shell';
import { RequireAdmin } from '../require-admin';

const session = { user: null as { id: number; username: string; role?: string; role_level?: number } | null, isLoading: false };

vi.mock('../app-shell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div data-testid="shell">{children}</div>,
}));
vi.mock('../realtime', () => ({
  RealtimeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useRealtimeStatus: () => 'online',
}));
vi.mock('../../features/session/use-session', () => ({
  useSession: () => ({ user: session.user, isLoading: session.isLoading, isError: false, error: null, refetch: vi.fn() }),
  isAdminUser: (user: { role?: string; role_level?: number } | null | undefined) =>
    Boolean(user) && (Number(user?.role_level ?? 0) >= 2 || String(user?.role ?? '').toLowerCase().includes('admin')),
}));

function LoginProbe() {
  const location = useLocation();
  return (
    <div>
      <span>LOGIN_PAGE</span>
      <span data-testid="login-search">{location.search}</span>
    </div>
  );
}

function renderApp(initial: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/login" element={<LoginProbe />} />
          <Route element={<ProtectedShell />}>
            <Route path="/dash" element={<div>DASH_PAGE</div>} />
            <Route path="/dash/domains" element={<div>DOMAINS_PAGE</div>} />
            <Route element={<RequireAdmin />}>
              <Route path="/dash/admin" element={<div>ADMIN_PAGE</div>} />
            </Route>
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('路由守卫', () => {
  beforeEach(() => { session.user = null; session.isLoading = false; });

  it('未登录访问 /dash 跳登录', () => {
    renderApp('/dash');
    expect(screen.getByText('LOGIN_PAGE')).toBeTruthy();
  });

  it('普通用户可进控制台但进不了管理页（落回 /dash）', () => {
    session.user = { id: 2, username: 'ops', role: 'user', role_level: 1 };
    renderApp('/dash/admin');
    expect(screen.getByText('DASH_PAGE')).toBeTruthy();
    expect(screen.queryByText('ADMIN_PAGE')).toBeNull();
  });

  it('管理员可进管理页', () => {
    session.user = { id: 1, username: 'admin', role: 'admin', role_level: 2 };
    renderApp('/dash/admin');
    expect(screen.getByText('ADMIN_PAGE')).toBeTruthy();
  });

  it('会话失效被踢回登录页时带上来源路径（登录后能回到原页面）', () => {
    renderApp('/dash/domains?page=2');
    expect(screen.getByText('LOGIN_PAGE')).toBeTruthy();
    expect(screen.getByTestId('login-search').textContent)
      .toBe('?return_to=' + encodeURIComponent('/dash/domains?page=2'));
  });

  it('会话校验中不渲染页面也不跳转', () => {
    session.isLoading = true;
    renderApp('/dash');
    expect(screen.queryByText('DASH_PAGE')).toBeNull();
    expect(screen.queryByText('LOGIN_PAGE')).toBeNull();
  });
});
