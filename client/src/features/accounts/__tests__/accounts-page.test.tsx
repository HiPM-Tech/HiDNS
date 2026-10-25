import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountsPage } from '../accounts-page';
import { deleteAccount, listAccounts, listProviders } from '../api';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    listAccounts: vi.fn(),
    listProviders: vi.fn(),
    createAccount: vi.fn(),
    updateAccount: vi.fn(),
    deleteAccount: vi.fn(),
  };
});

const providers = [
  {
    type: 'aliyun',
    name: '阿里云',
    capabilities: { dns: { recordTypes: ['A'] } },
    configFields: [
      { key: 'AccessKeyId', label: 'AccessKey ID', type: 'text' as const, required: true },
      { key: 'AccessKeySecret', label: 'AccessKey Secret', type: 'password' as const, required: true },
    ],
  },
];

const accounts = [
  { id: 1, name: '阿里云-主账号', type: 'aliyun', remark: '生产', enabled: true },
  { id: 2, name: '备用账号', type: 'aliyun', remark: '', enabled: 0 },
];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><AccountsPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AccountsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listProviders).mockResolvedValue(providers);
  });

  it('渲染账户、提供商名与状态', async () => {
    vi.mocked(listAccounts).mockResolvedValue(accounts);
    renderPage();

    expect(await screen.findByText('阿里云-主账号')).toBeTruthy();
    expect(screen.getByText('备用账号')).toBeTruthy();
    expect(screen.getAllByText('阿里云').length).toBeGreaterThan(0);
    expect(screen.getByText('已启用')).toBeTruthy();
    expect(screen.getByText('已禁用')).toBeTruthy();
  });

  it('空列表提示', async () => {
    vi.mocked(listAccounts).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('还没有 DNS 账户')).toBeTruthy();
  });

  it('删除账户需要二次确认', async () => {
    const user = userEvent.setup();
    vi.mocked(listAccounts).mockResolvedValue(accounts);
    vi.mocked(deleteAccount).mockResolvedValue({ code: 0, msg: 'success', data: null });
    renderPage();

    await user.click(await screen.findByRole('button', { name: '删除 阿里云-主账号' }));
    expect(await screen.findByText('删除账户')).toBeTruthy();
    expect(deleteAccount).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(deleteAccount).toHaveBeenCalledWith(1));
  });
});
