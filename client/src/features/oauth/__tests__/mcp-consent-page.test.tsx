import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpConsentPage } from '../mcp-consent-page';
import { requestRaw } from '../../../lib/http';

vi.mock('../../../lib/http', () => ({ requestRaw: vi.fn() }));
vi.mock('../../session/use-session', () => ({
  useSession: () => ({ user: { id: 1, username: 'admin', role: 'super_admin' }, isLoading: false, isError: false }),
  isAdminUser: () => true,
}));

const QUERY = '?client_id=mcp_client_a1&redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Fcb&scope=domain_management%3Aread%2Cns_monitor%3Awrite&state=st1&type=mcp&app_name=Claude%20Desktop';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/oauth/authorize' + QUERY]}>
      <McpConsentPage />
    </MemoryRouter>,
  );
}

describe('McpConsentPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('逐模块展示申请权限与客户端信息', () => {
    renderPage();
    expect(screen.getByText('Claude Desktop')).toBeTruthy();
    expect(screen.getByText('域名管理')).toBeTruthy();
    expect(screen.getByText('NS 监控')).toBeTruthy();
    expect(screen.getByText('读写')).toBeTruthy();
    expect(screen.getByText('mcp_client_a1')).toBeTruthy();
  });

  it('同意时提交 approve 并跳转服务端给出的地址', async () => {
    const user = userEvent.setup();
    vi.mocked(requestRaw).mockResolvedValue({ ok: true, status: 200, data: { redirect_url: 'http://127.0.0.1:8765/cb?code=abc' } });
    const original = window.location;
    // jsdom 不允许直接赋值 location.href，替换为可断言的对象
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, href: '' } });
    renderPage();

    await user.click(screen.getByRole('button', { name: '同意授权' }));
    await waitFor(() => expect(requestRaw).toHaveBeenCalledWith('/mcp/oauth/authorize', expect.objectContaining({ decision: 'approve', state: 'st1', client_id: 'mcp_client_a1' })));
    expect(window.location.href).toBe('http://127.0.0.1:8765/cb?code=abc');
    Object.defineProperty(window, 'location', { configurable: true, value: original });
  });

  it('拒绝时提交 deny', async () => {
    const user = userEvent.setup();
    vi.mocked(requestRaw).mockResolvedValue({ ok: true, status: 200, data: { redirect_url: 'http://127.0.0.1:8765/cb?error=access_denied' } });
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, href: '' } });
    renderPage();

    await user.click(screen.getByRole('button', { name: '拒绝' }));
    await waitFor(() => expect(requestRaw).toHaveBeenCalledWith('/mcp/oauth/authorize', expect.objectContaining({ decision: 'deny' })));
    Object.defineProperty(window, 'location', { configurable: true, value: original });
  });

  it('授权失败展示错误且按钮恢复可用', async () => {
    const user = userEvent.setup();
    vi.mocked(requestRaw).mockResolvedValue({ ok: false, status: 400, data: { error: 'invalid_request', error_description: 'redirect_uri 未注册' } });
    renderPage();

    await user.click(screen.getByRole('button', { name: '同意授权' }));
    expect(await screen.findByText('redirect_uri 未注册')).toBeTruthy();
    expect((screen.getByRole('button', { name: '同意授权' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
