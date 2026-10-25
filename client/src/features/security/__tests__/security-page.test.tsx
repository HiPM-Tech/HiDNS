import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SecurityPage } from '../security-page';
import { securityApi } from '../api';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    securityApi: {
      getPolicy: vi.fn(),
      updatePolicy: vi.fn(),
      twoFactorStatus: vi.fn(),
      setupTwoFactor: vi.fn(),
      enableTwoFactor: vi.fn(),
      disableTwoFactor: vi.fn(),
      listPasskeys: vi.fn(),
      deletePasskey: vi.fn(),
      passkeyRegistrationOptions: vi.fn(),
      passkeyRegistrationVerify: vi.fn(),
      trustedDevices: vi.fn(),
      removeTrustedDevice: vi.fn(),
      removeAllTrustedDevices: vi.fn(),
    },
  };
});

let sessionUser: { id: number; username: string; role_level: number } = { id: 1, username: 'admin', role_level: 3 };
vi.mock('../../session/use-session', () => ({
  useSession: () => ({ user: sessionUser, isLoading: false, isError: false }),
  isAdminUser: (user: { role_level?: number } | null) => Number(user?.role_level ?? 0) >= 2,
}));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SecurityPage />
    </QueryClientProvider>,
  );
}

describe('SecurityPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionUser = { id: 1, username: 'admin', role_level: 3 };
    vi.mocked(securityApi.twoFactorStatus).mockResolvedValue({ code: 0, msg: 'success', data: { configured: false, enabled: false, validationEnabled: false } });
    vi.mocked(securityApi.trustedDevices).mockResolvedValue({ code: 0, msg: 'success', data: [] });
    vi.mocked(securityApi.listPasskeys).mockResolvedValue({ code: 0, msg: 'success', data: [] });
    vi.mocked(securityApi.getPolicy).mockResolvedValue({
      code: 0, msg: 'success',
      data: { require2FAGlobal: false, minPasswordLength: 8, minPasswordStrength: 2, sessionTimeoutHours: 168, maxLoginAttempts: 5, lockoutDurationMinutes: 15, allowRememberDevice: true },
    });
  });

  it('未启用 2FA 时展示启用入口与空设备提示', async () => {
    renderPage();
    expect(await screen.findByText('未启用')).toBeTruthy();
    expect(screen.getByRole('button', { name: '启用两步验证' })).toBeTruthy();
    expect(screen.getByText('还没有受信任的设备')).toBeTruthy();
    expect(screen.getByText('还没有注册通行密钥')).toBeTruthy();
  });

  it('点击启用后拉取密钥并展示二维码与备用码', async () => {
    const user = userEvent.setup();
    vi.mocked(securityApi.setupTwoFactor).mockResolvedValue({
      code: 0, msg: 'success',
      data: { secret: 'JBSWY3DPEHPK3PXP', qrCode: 'data:image/png;base64,AAA', backupCodes: ['aaaa1111', 'bbbb2222'] },
    });
    renderPage();

    await user.click(await screen.findByRole('button', { name: '启用两步验证' }));
    expect(await screen.findByAltText('两步验证二维码')).toBeTruthy();
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeTruthy();
    expect(screen.getByText('aaaa1111')).toBeTruthy();
  });

  it('管理员可见安全策略，普通用户不可见', async () => {
    renderPage();
    expect(await screen.findByText('安全策略（管理员）')).toBeTruthy();
  });

  it('保存策略调用 updatePolicy', async () => {
    const user = userEvent.setup();
    vi.mocked(securityApi.updatePolicy).mockResolvedValue({ code: 0, msg: 'success', data: null });
    renderPage();

    const input = await screen.findByLabelText('密码最小长度');
    await user.clear(input);
    await user.type(input, '12');
    await user.click(screen.getByRole('button', { name: '保存策略' }));

    await waitFor(() => expect(securityApi.updatePolicy).toHaveBeenCalledTimes(1));
    expect(vi.mocked(securityApi.updatePolicy).mock.calls[0][0]).toMatchObject({ minPasswordLength: 12 });
  });
});
