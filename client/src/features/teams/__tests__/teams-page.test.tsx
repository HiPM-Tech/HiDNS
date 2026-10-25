import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamsPage } from '../teams-page';
import { teamsApi } from '../api';

vi.mock('../../session/use-session', () => ({
  useSession: () => ({ user: { id: 1, username: 'admin', role: 'super_admin', role_level: 3 }, isLoading: false, isError: false }),
  isAdminUser: () => true,
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    teamsApi: {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      members: vi.fn(),
      addMember: vi.fn(),
      removeMember: vi.fn(),
      teamPermissions: vi.fn(),
      addTeamPermission: vi.fn(),
      removeTeamPermission: vi.fn(),
      memberPermissions: vi.fn(),
      addMemberPermission: vi.fn(),
      removeMemberPermission: vi.fn(),
      users: vi.fn(),
      domains: vi.fn(),
    },
  };
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TeamsPage />
    </QueryClientProvider>,
  );
}

describe('TeamsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(teamsApi.list).mockResolvedValue([
      { id: 1, name: '运维组', description: '线上运维' },
      { id: 2, name: '研发组', description: '' },
    ]);
    vi.mocked(teamsApi.members).mockResolvedValue([
      { user_id: 10, username: 'alice', nickname: '爱丽丝', role: 'admin' },
      { user_id: 11, username: 'bob', role: 'member' },
    ]);
    vi.mocked(teamsApi.teamPermissions).mockResolvedValue([
      { id: 5, domain_id: 3, domain_name: 'example.com', permission: 'write' },
    ]);
    vi.mocked(teamsApi.users).mockResolvedValue([{ id: 12, username: 'carol' }]);
    vi.mocked(teamsApi.domains).mockResolvedValue([{ id: 3, name: 'example.com' }]);
  });

  it('渲染团队列表、成员与团队授权', async () => {
    renderPage();

    // 选中项改为派生后，列表项与详情标题会同时出现同名团队
    expect((await screen.findAllByText('运维组')).length).toBeGreaterThan(0);
    expect(screen.getByText('研发组')).toBeTruthy();
    expect(await screen.findByText('爱丽丝')).toBeTruthy();
    expect(screen.getByText('bob')).toBeTruthy();
    expect(screen.getByText('example.com')).toBeTruthy();
    expect(screen.getByText('读写')).toBeTruthy();
  });

  it('新增团队提交名称与描述', async () => {
    const user = userEvent.setup();
    vi.mocked(teamsApi.create).mockResolvedValue({ code: 0, msg: 'success', data: { id: 9 } });
    renderPage();

    await user.click(await screen.findByRole('button', { name: /新增团队/ }));
    await user.type(screen.getByLabelText('名称'), '安全组');
    await user.type(screen.getByLabelText('描述'), '负责安全审计');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(teamsApi.create).toHaveBeenCalledWith({ name: '安全组', description: '负责安全审计' }));
  });

  it('移除成员调用接口', async () => {
    const user = userEvent.setup();
    vi.mocked(teamsApi.removeMember).mockResolvedValue({ code: 0, msg: 'success', data: null });
    renderPage();

    await user.click(await screen.findByRole('button', { name: '移除 bob' }));
    await waitFor(() => expect(teamsApi.removeMember).toHaveBeenCalledWith(1, 11));
  });

  it('删除团队需要二次确认', async () => {
    const user = userEvent.setup();
    vi.mocked(teamsApi.remove).mockResolvedValue({ code: 0, msg: 'success', data: null });
    renderPage();

    await user.click(await screen.findByRole('button', { name: '删除' }));
    expect(await screen.findByText('删除团队')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(teamsApi.remove).toHaveBeenCalledWith(1));
  });
});
