import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainsPage } from '../domains-page';
import * as api from '../api';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    listDomains: vi.fn(),
    listDomainAccounts: vi.fn(),
    updateDomain: vi.fn(),
    deleteDomain: vi.fn(),
    addDomains: vi.fn(),
    listProviderDomains: vi.fn(),
  };
});

const domains = [
  { id: 1, name: 'example.com', account_id: 1, remark: '', enabled: 1, expires_at: null, whois_status: 'active', record_count: 12 },
  { id: 2, name: 'acme.net', account_id: 1, remark: '测试域', enabled: 0, whois_status: 'expired' },
];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DomainsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DomainsPage 置顶 / 备注 / WHOIS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(api.listDomains).mockResolvedValue({ list: domains as never, total: 2, page: 1, pageSize: 20, totalPages: 1 });
    vi.mocked(api.listDomainAccounts).mockResolvedValue([{ id: 1, name: '阿里云', type: 'aliyun' }]);
  });

  it('展示 WHOIS 状态徽标', async () => {
    renderPage();
    expect(await screen.findByText('WHOIS：正常')).toBeTruthy();
    expect(screen.getByText('WHOIS：已过期')).toBeTruthy();
  });

  it('置顶写入本地并作为查询参数下发', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '置顶 example.com' }));
    expect(JSON.parse(localStorage.getItem('hidns.domains.pinned') ?? '[]')).toEqual([1]);

    await waitFor(() => expect(
      vi.mocked(api.listDomains).mock.calls.at(-1)?.[0],
    ).toMatchObject({ pinned_domains: '1' }));
    expect(await screen.findByRole('button', { name: '取消置顶 example.com' })).toBeTruthy();
  });

  it('编辑备注提交 remark', async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateDomain).mockResolvedValue({ code: 0, msg: 'success', data: null } as never);
    renderPage();

    await user.click(await screen.findByRole('button', { name: '编辑备注 example.com' }));
    const input = screen.getByLabelText('备注');
    await user.type(input, '生产主域');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(api.updateDomain).toHaveBeenCalledWith(1, { remark: '生产主域' }));
  });
});
