import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AddDomainDialog } from '../add-domain-dialog';
import { addDomains, listProviderDomains } from '../api';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, addDomains: vi.fn(), listProviderDomains: vi.fn() };
});
vi.mock('../use-domains', () => ({
  useDomainAccounts: () => ({ data: [{ id: 7, name: '阿里云-主账号' }], isLoading: false }),
}));

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AddDomainDialog open onOpenChange={() => undefined} onAdded={() => undefined} />
    </QueryClientProvider>,
  );
}

describe('AddDomainDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('未选择账户时不拉取域名，添加按钮禁用', async () => {
    renderDialog();
    expect(await screen.findByText('请先选择账户')).toBeTruthy();
    expect((screen.getByRole('button', { name: /添加/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(listProviderDomains).not.toHaveBeenCalled();
  });

  it('addDomains 以 account_id + 域名数组提交', async () => {
    vi.mocked(addDomains).mockResolvedValue({ added: 1, skipped: 0 });
    const result = await addDomains(7, [{ name: 'example.com', third_id: 't1' }]);
    expect(result).toEqual({ added: 1, skipped: 0 });
    expect(addDomains).toHaveBeenCalledWith(7, [{ name: 'example.com', third_id: 't1' }]);
  });
});
