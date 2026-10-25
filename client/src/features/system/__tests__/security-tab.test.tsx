import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemSecurityTab } from '../security-tab';
import { systemSecurityApi } from '../security-api';

vi.mock('../security-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../security-api')>();
  return {
    ...actual,
    systemSecurityApi: {
      loginLimit: vi.fn(),
      updateLoginLimit: vi.fn(),
      loginStats: vi.fn(),
      unlock: vi.fn(),
      smtp: vi.fn(),
      updateSmtp: vi.fn(),
      testSmtp: vi.fn(),
      securityConfig: vi.fn(),
      updateSecurityConfig: vi.fn(),
      auditRules: vi.fn(),
      updateAuditRules: vi.fn(),
      mcpConfig: vi.fn(),
      updateMcpConfig: vi.fn(),
    },
  };
});

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SystemSecurityTab />
    </QueryClientProvider>,
  );
}

describe('SystemSecurityTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(systemSecurityApi.loginLimit).mockResolvedValue({ enabled: true, maxAttempts: 5, lockoutDuration: 15 });
    vi.mocked(systemSecurityApi.loginStats).mockResolvedValue([{ identifier: 'alice', attempts: 7 }]);
    vi.mocked(systemSecurityApi.smtp).mockResolvedValue({
      enabled: true, host: 'smtp.example.com', port: 587, secure: true,
      username: 'mailer', password: '***', fromEmail: 'no-reply@example.com', fromName: 'HiDNS',
    });
    vi.mocked(systemSecurityApi.securityConfig).mockResolvedValue({ showDnsProviderSecrets: false, domainExpiryNotify: true, domainExpiryDays: 30 });
    vi.mocked(systemSecurityApi.auditRules).mockResolvedValue({ enabled: true, maxDeletionsPerHour: 10, maxFailedLogins: 5, offHoursStart: '22:00', offHoursEnd: '06:00' });
    vi.mocked(systemSecurityApi.mcpConfig).mockResolvedValue({ enabled: true });
  });

  it('渲染登录限制、SMTP 与统计', async () => {
    renderTab();
    expect(await screen.findByText('登录限制')).toBeTruthy();
    expect(screen.getByText('SMTP')).toBeTruthy();
    expect((await screen.findByLabelText('服务器') as HTMLInputElement).value).toBe('smtp.example.com');
    expect(await screen.findByText('alice')).toBeTruthy();
  });

  it('保存登录限制提交配置', async () => {
    const user = userEvent.setup();
    vi.mocked(systemSecurityApi.updateLoginLimit).mockResolvedValue({ code: 0, msg: 'success', data: null });
    renderTab();

    const input = await screen.findByLabelText('最大失败次数');
    await user.clear(input);
    await user.type(input, '8');
    await user.click(screen.getByRole('button', { name: '保存登录限制' }));

    await waitFor(() => expect(systemSecurityApi.updateLoginLimit).toHaveBeenCalledTimes(1));
    expect(vi.mocked(systemSecurityApi.updateLoginLimit).mock.calls[0][0]).toMatchObject({ maxAttempts: 8, lockoutDuration: 15 });
  });

  it('SMTP 保存使用后端字段名（username/password/fromEmail/fromName/secure）', async () => {
    const user = userEvent.setup();
    vi.mocked(systemSecurityApi.updateSmtp).mockResolvedValue({ code: 0, msg: 'success', data: {} } as never);
    renderTab();

    const host = await screen.findByLabelText('服务器');
    expect((host as HTMLInputElement).value).toBe('smtp.example.com');
    expect((screen.getByLabelText('发件邮箱') as HTMLInputElement).value).toBe('no-reply@example.com');

    await user.click(screen.getByRole('button', { name: '保存 SMTP' }));
    await waitFor(() => expect(systemSecurityApi.updateSmtp).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(systemSecurityApi.updateSmtp).mock.calls[0][0];
    expect(payload).toMatchObject({ username: 'mailer', fromEmail: 'no-reply@example.com', fromName: 'HiDNS', secure: true });
    expect(payload).not.toHaveProperty('user');
    expect(payload).not.toHaveProperty('pass');
    expect(payload).not.toHaveProperty('from');
  });

  it('测试邮件与解锁分别调用对应接口', async () => {
    const user = userEvent.setup();
    vi.mocked(systemSecurityApi.testSmtp).mockResolvedValue({ code: 0, msg: 'success', data: null });
    vi.mocked(systemSecurityApi.unlock).mockResolvedValue({ code: 0, msg: 'success', data: null });
    renderTab();

    await user.type(await screen.findByLabelText('测试收件地址'), 'ops@example.com');
    await user.click(screen.getByRole('button', { name: '发送测试' }));
    await waitFor(() => expect(systemSecurityApi.testSmtp).toHaveBeenCalledWith('ops@example.com'));

    await user.type(screen.getByLabelText('解锁目标'), 'bob');
    await user.click(screen.getByRole('button', { name: '解锁' }));
    await waitFor(() => expect(systemSecurityApi.unlock).toHaveBeenCalledWith('bob'));
  });
});
