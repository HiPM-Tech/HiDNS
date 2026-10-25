import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainRenewalTab } from '../renewal-tab';
import { renewalApi } from '../renewal-api';

vi.mock('../renewal-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../renewal-api')>();
  return {
    ...actual,
    renewalApi: {
      list: vi.fn(),
      remove: vi.fn(),
      toggle: vi.fn(),
      renew: vi.fn(),
      providerDomains: vi.fn(),
      add: vi.fn(),
    },
  };
});
vi.mock('../../accounts/use-accounts', () => ({
  useAccounts: () => ({ data: [{ id: 1, name: '阿里云', type: 'aliyun' }], isLoading: false }),
}));

const rows = [
  { id: 1, name: 'example.com', account_id: 1, account_name: '阿里云', expires_at: new Date(Date.now() + 5 * 86400000).toISOString(), enabled: 1, last_renewed_at: new Date(Date.now() - 86400000).toISOString() },
  { id: 2, name: 'acme.net', account_id: 1, account_name: '阿里云', enabled: 0 },
];

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DomainRenewalTab />
    </QueryClientProvider>,
  );
}

describe('DomainRenewalTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('渲染域名、剩余天数与续期开关', async () => {
    vi.mocked(renewalApi.list).mockResolvedValue({ list: rows as never, total: 2 });
    renderTab();

    expect(await screen.findByText('example.com')).toBeTruthy();
    expect(screen.getByText('acme.net')).toBeTruthy();
    expect(screen.getByText('5 天')).toBeTruthy();
    expect(screen.getByText(/2 条可续期域名/)).toBeTruthy();
    expect((screen.getByRole('switch', { name: '自动续期 example.com' }) as HTMLButtonElement).getAttribute('aria-checked')).toBe('true');
    expect((screen.getByRole('switch', { name: '自动续期 acme.net' }) as HTMLButtonElement).getAttribute('aria-checked')).toBe('false');
  });

  it('续期按钮调用后端', async () => {
    const user = userEvent.setup();
    vi.mocked(renewalApi.list).mockResolvedValue({ list: rows as never, total: 2 });
    vi.mocked(renewalApi.renew).mockResolvedValue({ code: 0, msg: 'success', data: null } as never);
    renderTab();

    await user.click((await screen.findAllByRole('button', { name: /续期/ })).find((b) => b.textContent === '续期')!);
    await waitFor(() => expect(renewalApi.renew).toHaveBeenCalled());
  });

  it('切换自动续期调用 toggle', async () => {
    const user = userEvent.setup();
    vi.mocked(renewalApi.list).mockResolvedValue({ list: rows as never, total: 2 });
    vi.mocked(renewalApi.toggle).mockResolvedValue({ code: 0, msg: 'success', data: null });
    renderTab();

    await user.click(await screen.findByRole('switch', { name: '自动续期 example.com' }));
    await waitFor(() => expect(renewalApi.toggle).toHaveBeenCalledWith(1, false));
  });

  it('移除需要二次确认', async () => {
    const user = userEvent.setup();
    vi.mocked(renewalApi.list).mockResolvedValue({ list: rows as never, total: 2 });
    vi.mocked(renewalApi.remove).mockResolvedValue({ code: 0, msg: 'success', data: null });
    renderTab();

    await user.click(await screen.findByRole('button', { name: '移除 example.com' }));
    expect(await screen.findByText('移除可续期域名')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '确认移除' }));
    await waitFor(() => expect(renewalApi.remove).toHaveBeenCalledWith(1));
  });
});
