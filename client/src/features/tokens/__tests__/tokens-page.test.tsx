import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokensPage } from '../tokens-page';
import { createToken, deleteToken, listTokenDomains, listTokens } from '../api';

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

const tokens = [
  { id: 1, name: 'DDNS-家庭', allowed_domains: [3, 4], allowed_services: ['dns'], max_role: 1, is_active: true, last_used_at: new Date().toISOString() },
  { id: 2, name: 'CI 脚本', allowed_domains: [3], allowed_services: ['dns', 'mcp'], max_role: 2, is_active: 0 },
];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><TokensPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('TokensPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listTokenDomains).mockResolvedValue([
      { id: 3, name: 'example.com', account_name: '阿里云' },
      { id: 4, name: 'acme.net', account_name: 'Cloudflare' },
    ]);
  });

  it('渲染令牌行、服务标签与状态', async () => {
    vi.mocked(listTokens).mockResolvedValue(tokens as never);
    renderPage();

    expect(await screen.findByText('DDNS-家庭')).toBeTruthy();
    expect(screen.getByText('CI 脚本')).toBeTruthy();
    expect(screen.getAllByText('dns').length).toBeGreaterThan(0);
    expect(screen.getByText('已启用')).toBeTruthy();
    expect(screen.getByText('已停用')).toBeTruthy();
    expect(screen.getByText('2 个')).toBeTruthy();
  });

  it('创建令牌：未选域名时报错，选后提交并展示明文', async () => {
    const user = userEvent.setup();
    vi.mocked(listTokens).mockResolvedValue([]);
    vi.mocked(createToken).mockResolvedValue({
      code: 0, msg: 'success', data: { token: 'dnsmgr_abc', tokenData: { id: 9, name: 'x', allowed_domains: [3], allowed_services: ['dns'] } },
    } as never);
    renderPage();

    await user.click(await screen.findByRole('button', { name: /新增令牌/ }));
    await user.type(screen.getByLabelText('名称'), '家庭 DDNS');
    await user.click(screen.getByRole('button', { name: '创建令牌' }));
    expect(await screen.findByText('至少选择一个域名')).toBeTruthy();
    expect(createToken).not.toHaveBeenCalled();

    await user.click(screen.getByRole('checkbox', { name: /example.com/ }));
    await user.click(screen.getByRole('button', { name: '创建令牌' }));

    await waitFor(() => expect(createToken).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createToken).mock.calls[0][0]).toMatchObject({
      name: '家庭 DDNS',
      allowed_domains: [3],
      allowed_services: ['dns'],
      max_role: 2,
    });
    expect(await screen.findByText('dnsmgr_abc')).toBeTruthy();
  });

  it('删除令牌需要二次确认', async () => {
    const user = userEvent.setup();
    vi.mocked(listTokens).mockResolvedValue(tokens as never);
    vi.mocked(deleteToken).mockResolvedValue({ code: 0, msg: 'success', data: null });
    renderPage();

    await user.click(await screen.findByRole('button', { name: '删除 DDNS-家庭' }));
    expect(await screen.findByText('删除令牌')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(deleteToken).toHaveBeenCalledWith(1));
  });
});
