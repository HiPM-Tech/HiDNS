import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** useSession 的可变返回值：每个用例改字段即可切换登录态 */
const state = vi.hoisted(() => ({
  user: null as { id: number; username: string } | null,
  isLoading: false,
}));

vi.mock('../../session/use-session', () => ({
  useSession: () => ({
    user: state.user,
    isLoading: state.isLoading,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

import { RedirectIfAuthed } from '../../../app/redirect-if-authed';

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/login" element={<RedirectIfAuthed><div>登录表单</div></RedirectIfAuthed>} />
        <Route path="/dash" element={<div>控制台面板</div>} />
        <Route path="/dash/tokens" element={<div>令牌页</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RedirectIfAuthed：登录页的已登录重定向', () => {
  beforeEach(() => {
    state.user = null;
    state.isLoading = false;
  });

  it('未登录：正常渲染登录页', () => {
    renderAt('/login');
    expect(screen.getByText('登录表单')).toBeTruthy();
  });

  it('有有效会话：直接进面板，不再渲染登录表单', () => {
    state.user = { id: 1, username: 'admin' };
    renderAt('/login');
    expect(screen.getByText('控制台面板')).toBeTruthy();
    expect(screen.queryByText('登录表单')).toBeNull();
  });

  it('有会话且带 return_to：跳到指定站内路径', () => {
    state.user = { id: 1, username: 'admin' };
    renderAt('/login?return_to=%2Fdash%2Ftokens');
    expect(screen.getByText('令牌页')).toBeTruthy();
  });

  it('return_to 是外链：退回 /dash，不做开放重定向', () => {
    state.user = { id: 1, username: 'admin' };
    renderAt('/login?return_to=https%3A%2F%2Fevil.example');
    expect(screen.getByText('控制台面板')).toBeTruthy();
  });

  it('会话校验中：只显示占位，不闪登录表单', () => {
    state.isLoading = true;
    renderAt('/login');
    expect(screen.getByText('正在校验登录状态…')).toBeTruthy();
    expect(screen.queryByText('登录表单')).toBeNull();
  });
});
