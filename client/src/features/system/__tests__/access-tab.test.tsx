import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemAccessTab } from '../access-tab';
import { systemSecurityApi } from '../security-api';

vi.mock('../security-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../security-api')>();
  return {
    ...actual,
    systemSecurityApi: {
      ...actual.systemSecurityApi,
      jwtSecret: vi.fn(),
      oauthConfig: vi.fn(),
      updateOAuthConfig: vi.fn(),
      discoverOidc: vi.fn(),
      logtoConfig: vi.fn(),
      updateLogtoConfig: vi.fn(),
    },
  };
});

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SystemAccessTab />
    </QueryClientProvider>,
  );
}

describe('SystemAccessTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(systemSecurityApi.oauthConfig).mockResolvedValue({ enabled: false, providerName: 'default', issuer: 'https://sso.example.com', clientId: 'cid' });
    vi.mocked(systemSecurityApi.logtoConfig).mockResolvedValue({ enabled: false, providerName: 'Logto', logtoDomain: '' });
  });

  it('查看 JWT 密钥：默认打码，可切换显示', async () => {
    const user = userEvent.setup();
    vi.mocked(systemSecurityApi.jwtSecret).mockResolvedValue({ jwtSecret: 'super-secret' });
    renderTab();

    await user.type(await screen.findByLabelText('管理员密码'), 'adminpass');
    await user.click(screen.getByRole('button', { name: '查看' }));

    expect(systemSecurityApi.jwtSecret).toHaveBeenCalledWith('adminpass');
    expect(await screen.findByText('••••••••••••')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '显示密钥' }));
    expect(screen.getByText('super-secret')).toBeTruthy();
  });

  it('OIDC 自动发现填充端点', async () => {
    const user = userEvent.setup();
    vi.mocked(systemSecurityApi.discoverOidc).mockResolvedValue({
      authorizationEndpoint: 'https://sso.example.com/authorize',
      tokenEndpoint: 'https://sso.example.com/token',
    });
    renderTab();

    await user.click(await screen.findByRole('button', { name: /自动发现/ }));
    await waitFor(() => expect(systemSecurityApi.discoverOidc).toHaveBeenCalledWith('https://sso.example.com'));
    await waitFor(() => expect((screen.getByLabelText('Token Endpoint') as HTMLInputElement).value).toBe('https://sso.example.com/token'));
  });

  it('保存 OAuth 与 Logto 分别提交配置', async () => {
    const user = userEvent.setup();
    vi.mocked(systemSecurityApi.updateOAuthConfig).mockResolvedValue({ code: 0, msg: 'success', data: {} } as never);
    vi.mocked(systemSecurityApi.updateLogtoConfig).mockResolvedValue({ code: 0, msg: 'success', data: {} } as never);
    renderTab();

    await user.click(await screen.findByRole('button', { name: '保存 OAuth 配置' }));
    await waitFor(() => expect(systemSecurityApi.updateOAuthConfig).toHaveBeenCalledTimes(1));
    expect(vi.mocked(systemSecurityApi.updateOAuthConfig).mock.calls[0][0]).toMatchObject({ issuer: 'https://sso.example.com', clientId: 'cid' });

    await user.type(screen.getByLabelText('Logto 域名'), 'https://demo.logto.app');
    await user.click(screen.getByRole('button', { name: '保存 Logto 配置' }));
    await waitFor(() => expect(systemSecurityApi.updateLogtoConfig).toHaveBeenCalled());
    expect(String(vi.mocked(systemSecurityApi.updateLogtoConfig).mock.calls[0][0].logtoDomain)).toContain('logto');
  });
});
