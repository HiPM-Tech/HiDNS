import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from '../settings-page';
import { settingsApi } from '../api';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    settingsApi: {
      updateProfile: vi.fn(),
      sendEmailCode: vi.fn(),
      changePassword: vi.fn(),
      getPreferences: vi.fn(),
      updatePreferences: vi.fn(),
      oauthBindings: vi.fn(),
      unbindOauth: vi.fn(),
      startOauthBind: vi.fn(),
    },
  };
});
vi.mock('../../session/use-session', () => ({
  useSession: () => ({
    user: { id: 1, username: 'admin', nickname: '管理员', email: 'admin@example.com', role_level: 3 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  isAdminUser: () => true,
}));
vi.mock('../../../utils/rsaEncrypt', () => ({
  encryptPassword: vi.fn(async (password: string) => `enc:${password}`),
}));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(settingsApi.getPreferences).mockResolvedValue({
      code: 0, msg: 'success',
      data: { notificationsEnabled: true, emailNotifications: false, avatarImage: '', backgroundImage: '' },
    });
    vi.mocked(settingsApi.oauthBindings).mockResolvedValue({ code: 0, msg: 'success', data: [] });
  });

  it('渲染四个区块与当前资料', async () => {
    renderPage();
    expect(await screen.findByText('个人资料')).toBeTruthy();
    expect(screen.getByText('修改密码')).toBeTruthy();
    expect(screen.getByText('偏好')).toBeTruthy();
    expect(screen.getByText('账号绑定')).toBeTruthy();
    expect((screen.getByLabelText('昵称') as HTMLInputElement).value).toBe('管理员');
    expect(await screen.findByText('还没有绑定任何外部账号')).toBeTruthy();
  });

  it('修改邮箱需要验证码，发送后提交带 emailCode', async () => {
    const user = userEvent.setup();
    vi.mocked(settingsApi.sendEmailCode).mockResolvedValue({ code: 0, msg: 'success', data: null });
    vi.mocked(settingsApi.updateProfile).mockResolvedValue({ code: 0, msg: 'success', data: { id: 1, username: 'admin' } });

    renderPage();
    const email = await screen.findByLabelText('邮箱');
    await user.clear(email);
    await user.type(email, 'new@example.com');

    await user.click(screen.getByRole('button', { name: '发送验证码' }));
    expect(settingsApi.sendEmailCode).toHaveBeenCalledWith('new@example.com');
    expect(await screen.findByText('验证码已发送到新邮箱')).toBeTruthy();

    await user.type(screen.getByLabelText('新邮箱验证码'), '123456');
    await user.click(screen.getByRole('button', { name: '保存资料' }));

    await waitFor(() => expect(settingsApi.updateProfile).toHaveBeenCalledTimes(1));
    expect(vi.mocked(settingsApi.updateProfile).mock.calls[0][0]).toMatchObject({
      nickname: '管理员',
      email: 'new@example.com',
      emailCode: '123456',
    });
  });

  it('清空邮箱或缺少验证码时本地拦截，不发请求', async () => {
    const user = userEvent.setup();
    vi.mocked(settingsApi.updateProfile).mockResolvedValue({ code: 0, msg: 'success', data: { id: 1, username: 'admin' } });
    renderPage();

    const email = await screen.findByLabelText('邮箱');
    await user.clear(email);
    await user.click(screen.getByRole('button', { name: '保存资料' }));
    expect(await screen.findByText('邮箱不能为空')).toBeTruthy();

    await user.type(email, 'next@example.com');
    await user.click(screen.getByRole('button', { name: '保存资料' }));
    expect(await screen.findByText('修改邮箱需要先获取并填写验证码')).toBeTruthy();
    expect(settingsApi.updateProfile).not.toHaveBeenCalled();
  });

  it('修改密码校验一致性与加密提交', async () => {
    const user = userEvent.setup();
    vi.mocked(settingsApi.changePassword).mockResolvedValue({ code: 0, msg: 'success', data: null });
    renderPage();

    await user.type(await screen.findByLabelText('当前密码'), 'oldpass');
    await user.type(screen.getByLabelText('新密码'), 'newpass123');
    await user.type(screen.getByLabelText('确认新密码'), 'mismatch');
    await user.click(screen.getByRole('button', { name: '更新密码' }));
    expect(await screen.findByText('两次输入的新密码不一致')).toBeTruthy();
    expect(settingsApi.changePassword).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('确认新密码'));
    await user.type(screen.getByLabelText('确认新密码'), 'newpass123');
    await user.click(screen.getByRole('button', { name: '更新密码' }));
    await waitFor(() => expect(settingsApi.changePassword).toHaveBeenCalledWith('enc:oldpass', 'enc:newpass123'));
  });
});
