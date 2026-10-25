import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainsPage } from '../domains-page';
import { listDomainAccounts, listDomains } from '../api';

const viewStateMocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('../view-state', () => ({ readDomainsViewState: viewStateMocks.read, writeDomainsViewState: viewStateMocks.write }));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, listDomains: vi.fn(), listDomainAccounts: vi.fn(), deleteDomain: vi.fn(), toggleDomain: vi.fn(), updateDomainRemark: vi.fn() };
});
vi.mock('../../session/use-session', () => ({
  useSession: () => ({ user: { id: 1, username: 'admin', role_level: 3 }, isLoading: false, isError: false }),
  isAdminUser: () => true,
}));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><DomainsPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listDomainAccounts).mockResolvedValue([]);
  viewStateMocks.read.mockReturnValue({ page: 1, pageSize: 20, keyword: '', accountId: 'all', status: 'all' });
  vi.mocked(listDomains).mockResolvedValue({ list: [], total: 45, page: 1, pageSize: 20, totalPages: 5 });
});

describe('域名列表分页状态保留', () => {
  it('从本地存储恢复分页参数', async () => {
    viewStateMocks.read.mockReturnValue({ page: 2, pageSize: 10, keyword: '', accountId: 'all', status: 'all' });
    renderPage();
    await waitFor(() => expect(listDomains).toHaveBeenCalledWith(expect.objectContaining({ page: 2, pageSize: 10 })));
    expect(await screen.findByText('第 2 / 5 页')).toBeTruthy();
  });

  it('翻页后写回本地存储，返回列表仍可恢复', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('第 1 / 5 页');
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(viewStateMocks.write).toHaveBeenCalledWith(expect.objectContaining({ page: 2 })));
  });
});
