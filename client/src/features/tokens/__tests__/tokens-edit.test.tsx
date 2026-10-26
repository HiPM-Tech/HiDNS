import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokensPage } from '../tokens-page';
import { listTokenDomains, listTokens, updateToken, type TokenRow } from '../api';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    listTokens: vi.fn(),
    listTokenDomains: vi.fn(),
    createToken: vi.fn(),
    updateToken: vi.fn(),
    deleteToken: vi.fn(),
    toggleTokenStatus: vi.fn(),
  };
});
vi.mock('../../session/use-session', () => ({
  useSession: () => ({ user: { id: 1, username: 'admin', role_level: 3 }, isLoading: false, isError: false }),
  isAdminUser: () => true,
}));

const token: TokenRow = { id: 1, name: 'DDNS-家庭', allowed_domains: [3], allowed_services: { dns: ['records.read'], mcp: ['*'] }, max_role: 1, is_active: true };

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><TokensPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TokensPage 编辑', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listTokens).mockResolvedValue([token]);
    vi.mocked(listTokenDomains).mockResolvedValue([{ id: 3, name: 'example.com' }]);
  });

  it('编辑按钮打开预填弹窗并提交更新', async () => {
    const user = userEvent.setup();
    vi.mocked(updateToken).mockResolvedValue({ code: 0, msg: 'success', data: null });
    renderPage();

    await user.click(await screen.findByRole('button', { name: '编辑 DDNS-家庭' }));
    expect(await screen.findByText('编辑 API 令牌')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'dns 服务' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'mcp 服务' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: '展开 dns 权限' }));
    expect(screen.getByRole('button', { name: 'records.read' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'records.write' }).getAttribute('aria-pressed')).toBe('false');

    const nameInput = screen.getByLabelText('名称');
    await user.clear(nameInput);
    await user.type(nameInput, 'DDNS-新');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(updateToken).toHaveBeenCalledWith(1, expect.objectContaining({
      name: 'DDNS-新', allowed_services: { dns: ['records.read'], mcp: ['*'] },
    })));
  });

  it('取消最后一个具体权限后保存为通配，取消 MCP 后省略其键', async () => {
    const user = userEvent.setup();
    vi.mocked(updateToken).mockResolvedValue({ code: 0, msg: 'success', data: null });
    renderPage();
    await user.click(await screen.findByRole('button', { name: '编辑 DDNS-家庭' }));
    await user.click(screen.getByRole('button', { name: '展开 dns 权限' }));
    await user.click(screen.getByRole('button', { name: 'records.read' }));
    await user.click(screen.getByRole('button', { name: 'mcp 服务' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(updateToken).toHaveBeenCalledWith(1, expect.objectContaining({ allowed_services: { dns: ['*'] } })));
  });

  it.each([{}, { dns: [] }])('编辑无权限配置时不会默认启用 DNS：%j', async (allowed_services) => {
    const user = userEvent.setup();
    vi.mocked(listTokens).mockResolvedValue([{ ...token, allowed_services }]);
    vi.mocked(updateToken).mockResolvedValue({ code: 0, msg: 'success', data: null });
    renderPage();
    expect(await screen.findByText('无服务权限')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '编辑 DDNS-家庭' }));
    expect(screen.getByRole('button', { name: 'dns 服务' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'mcp 服务' }).getAttribute('aria-pressed')).toBe('false');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(updateToken).toHaveBeenCalledWith(1, expect.objectContaining({ allowed_services: {} })));
  });
});
