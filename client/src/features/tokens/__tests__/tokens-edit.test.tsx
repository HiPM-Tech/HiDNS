import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokensPage } from '../tokens-page';
import { listTokenDomains, listTokens, updateToken } from '../api';

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

const token = { id: 1, name: 'DDNS-家庭', allowed_domains: [3], allowed_services: ['dns'], max_role: 1, is_active: true };

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
    vi.mocked(listTokens).mockResolvedValue([token] as never);
    vi.mocked(listTokenDomains).mockResolvedValue([{ id: 3, name: 'example.com' }]);
  });

  it('编辑按钮打开预填弹窗并提交更新', async () => {
    const user = userEvent.setup();
    vi.mocked(updateToken).mockResolvedValue({ code: 0, msg: 'success', data: null });
    renderPage();

    await user.click(await screen.findByRole('button', { name: '编辑 DDNS-家庭' }));
    expect(await screen.findByText('编辑 API 令牌')).toBeTruthy();

    const nameInput = screen.getByLabelText('名称');
    await user.clear(nameInput);
    await user.type(nameInput, 'DDNS-新');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(updateToken).toHaveBeenCalledWith(1, expect.objectContaining({ name: 'DDNS-新' })));
  });
});
