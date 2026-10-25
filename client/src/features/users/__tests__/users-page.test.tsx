import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UsersPage } from '../users-page';
import { usersApi } from '../api';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    usersApi: {
      list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(),
      twoFactorRequirement: vi.fn(), setTwoFactorRequirement: vi.fn(),
    },
  };
});
vi.mock('../../session/use-session', () => ({
  useSession: () => ({ user: { id: 1, username: 'admin', role: 'super_admin', role_level: 3 }, isLoading: false, isError: false }),
  isAdminUser: () => true,
}));

const rows = [
  { id: 1, username: 'admin', nickname: '管理员', email: 'admin@example.com', role: 3, status: 1, created_at: new Date().toISOString() },
  { id: 2, username: 'ops', nickname: '运维', email: 'ops@example.com', role: 2, status: 1 },
  { id: 3, username: 'dev', role: 1, status: 0 },
];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UsersPage />
    </QueryClientProvider>,
  );
}

describe('UsersPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('渲染用户、角色与状态', async () => {
    vi.mocked(usersApi.list).mockResolvedValue(rows as never);
    renderPage();

    expect(await screen.findByText('@admin')).toBeTruthy();
    expect(screen.getByText('@ops')).toBeTruthy();
    expect(screen.getAllByText('超级管理员').length).toBeGreaterThan(0);
    expect(screen.getAllByText('管理员').length).toBeGreaterThan(0);
    expect(screen.getAllByText('普通用户').length).toBeGreaterThan(0);
    expect(screen.getByText('已停用')).toBeTruthy();
  });

  it('超管账号不可编辑/删除', async () => {
    vi.mocked(usersApi.list).mockResolvedValue(rows as never);
    vi.mocked(usersApi.twoFactorRequirement).mockResolvedValue({ global2FAEnabled: false, configuredRequire2FA: false });
    renderPage();

    await screen.findByText('@admin');
    expect((screen.getByRole('button', { name: '编辑 admin' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '删除 admin' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '编辑 ops' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('新增用户校验用户名并提交', async () => {
    const user = userEvent.setup();
    vi.mocked(usersApi.list).mockResolvedValue([] as never);
    vi.mocked(usersApi.create).mockResolvedValue({ code: 0, msg: 'success', data: { id: 9 } });
    renderPage();

    await user.click(await screen.findByRole('button', { name: /新增用户/ }));
    await user.type(screen.getByLabelText('用户名'), 'bad name');
    await user.click(screen.getByRole('button', { name: '创建' }));
    expect(await screen.findByText(/用户名只能包含/)).toBeTruthy();
    expect(usersApi.create).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('用户名'));
    await user.type(screen.getByLabelText('用户名'), 'carol');
    await user.type(screen.getByLabelText('密码'), 'secret123');
    await user.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => expect(usersApi.create).toHaveBeenCalledTimes(1));
    expect(vi.mocked(usersApi.create).mock.calls[0][0]).toMatchObject({ username: 'carol', password: 'secret123' });
  });

  it('停用用户调用 update', async () => {
    const user = userEvent.setup();
    vi.mocked(usersApi.list).mockResolvedValue(rows as never);
    vi.mocked(usersApi.update).mockResolvedValue({ code: 0, msg: 'success', data: null });
    renderPage();

    const buttons = await screen.findAllByRole('button', { name: '停用' });
    const enabled = buttons.find((button) => !(button as HTMLButtonElement).disabled) as HTMLButtonElement;
    await user.click(enabled);
    await waitFor(() => expect(usersApi.update).toHaveBeenCalledWith(2, { status: 0 }));
  });
  it('本人行展示徽标，并可从操作列打开二次验证设置', async () => {
    const user = userEvent.setup();
    vi.mocked(usersApi.list).mockResolvedValue([
      { id: 1, username: 'admin', nickname: '管理员', role: 3, status: 1 },
      { id: 2, username: 'ops', nickname: '运维', role: 2, status: 1 },
    ] as never);
    vi.mocked(usersApi.twoFactorRequirement).mockResolvedValue({ global2FAEnabled: false, configuredRequire2FA: false, require2FA: false });
    renderPage();

    expect(await screen.findByText('本人')).toBeTruthy();
    // 目前登录用户是 id=1（见上方 use-session mock），只有一行带「本人」
    expect(screen.getAllByText('本人')).toHaveLength(1);

    const buttons = await screen.findAllByRole('button', { name: '二次验证' });
    const enabled = buttons.filter((button) => !(button as HTMLButtonElement).disabled);
    expect(enabled.length).toBeGreaterThan(0);
    await user.click(enabled[0]);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(await screen.findByLabelText('强制该用户启用二次验证')).toBeTruthy();
  });
});
