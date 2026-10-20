import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * 工作流是管理员专属能力。非管理员即使知道 URL，也不应看到页面内容。
 * 这里锁住路由级守卫：AdminRoute 必须把非管理员挡回 /dash。
 */

const authState = vi.hoisted(() => ({
  user: { id: 1, username: 'u', role: 'user' } as { id: number; username: string; role: string } | null,
  isAdmin: false,
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: authState.user, isAdmin: authState.isAdmin, isLoading: false }),
}));

import { AdminRoute } from './ProtectedRoute';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/dash" element={<div>dash-home</div>} />
        <Route element={<AdminRoute />}>
          <Route path="/dash/workflows" element={<div>workflows-page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  authState.user = { id: 1, username: 'u', role: 'user' };
  authState.isAdmin = false;
});

describe('管理员路由守卫', () => {
  it('非管理员访问工作流被挡回 /dash，页面内容不渲染', () => {
    renderAt('/dash/workflows');
    expect(screen.queryByText('workflows-page')).toBeNull();
    expect(screen.getByText('dash-home')).toBeTruthy();
  });

  it('管理员可以进入工作流页', () => {
    authState.isAdmin = true;
    authState.user = { id: 1, username: 'admin', role: 'admin' };
    renderAt('/dash/workflows');
    expect(screen.getByText('workflows-page')).toBeTruthy();
  });

  it('未登录时跳登录而不是工作流页', () => {
    authState.user = null;
    authState.isAdmin = false;
    renderAt('/dash/workflows');
    expect(screen.queryByText('workflows-page')).toBeNull();
  });
});
