import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainsPage } from '../domains-page';
import { deleteDomain, listDomainAccounts, listDomains } from '../api';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    listDomains: vi.fn(),
    listDomainAccounts: vi.fn(),
    deleteDomain: vi.fn(),
    updateDomain: vi.fn(),
  };
});

const domains = [
  { id: 1, name: 'example.com', account_id: 1, record_count: 128, expires_at: new Date(Date.now() + 3 * 86400000).toISOString(), enabled: 1 },
  { id: 2, name: 'demo.org', account_id: 2, record_count: 4, enabled: 0, remark: '备用' },
];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/dash/domains']}>
        <DomainsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DomainsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listDomainAccounts).mockResolvedValue([
      { id: 1, name: '阿里云-主账号', type: 'aliyun' },
      { id: 2, name: 'Cloudflare', type: 'cloudflare' },
    ]);
  });

  it('默认按「总是分组」请求，并提供分组方式开关', async () => {
    vi.mocked(listDomains).mockResolvedValue({ list: [], total: 0, page: 1, pageSize: 20, totalPages: 1 });
    renderPage();

    await waitFor(() => expect(listDomains).toHaveBeenCalled());
    // 用户开关默认 virtual：父域未添加也按可注册域造组
    expect(vi.mocked(listDomains).mock.calls.at(-1)?.[0]).toMatchObject({ grouped: true, virtual_groups: true });
    // 开关本身在分组开启时可见（strict 模式的行为由服务端单测覆盖）
    expect(screen.getByRole('combobox', { name: '分组方式' })).toBeTruthy();
  });

  it('分组：组头折叠时隐藏子域，展开后显示，且不可写域名隐藏写按钮', async () => {
    vi.mocked(listDomains).mockResolvedValue({
      list: [
        { _type: 'group_header', id: -2, groupName: 'e.com', childIds: [2, 3], parentPresent: false },
        { id: 2, name: 'e.com', account_id: 1, enabled: 1, can_write: true, _groupParentId: -2 },
        { id: 3, name: 'b.e.com', account_id: 1, enabled: 1, can_write: false, _groupParentId: -2 },
        { id: 4, name: 'other.net', account_id: 1, enabled: 1, can_write: false },
      ],
      total: 2,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });

    renderPage();

    // 组头可见，子域默认折叠（只显示组名与数量）
    const header = await screen.findByRole('button', { name: /e\.com/ });
    expect(header).toBeTruthy();
    // 虚拟组（父域未添加）在组头显示提示
    expect(screen.getByText('父域未添加')).toBeTruthy();
    expect(screen.queryByText('b.e.com')).toBeNull();

    // 展开后子域出现
    fireEvent.click(header);
    expect(await screen.findByText('b.e.com')).toBeTruthy();

    // 可写域名有删除按钮，只读域名没有（改为「只读」徽标）
    expect(screen.queryByLabelText('删除 b.e.com')).toBeNull();
    expect(screen.getByLabelText('删除 e.com')).toBeTruthy();
    expect(screen.getAllByText('只读').length).toBeGreaterThan(0);
  });

  it('渲染域名行、账户类型与状态', async () => {
    vi.mocked(listDomains).mockResolvedValue({ list: domains, total: 2, page: 1, pageSize: 20, totalPages: 1 });
    renderPage();

    expect(await screen.findByText('example.com')).toBeTruthy();
    expect(screen.getByText('demo.org')).toBeTruthy();
    expect(screen.getByText('aliyun')).toBeTruthy();
    expect(screen.getByText('128')).toBeTruthy();
    expect(screen.getByText('已启用')).toBeTruthy();
    expect(screen.getByText('已禁用')).toBeTruthy();
    expect(screen.getByText('共 2 个域名')).toBeTruthy();
  });

  it('空列表给出提示', async () => {
    vi.mocked(listDomains).mockResolvedValue({ list: [], total: 0, page: 1, pageSize: 20, totalPages: 1 });
    renderPage();
    expect(await screen.findByText('还没有添加域名')).toBeTruthy();
  });

  it('删除域名需要二次确认，确认后调用接口', async () => {
    const user = userEvent.setup();
    vi.mocked(listDomains).mockResolvedValue({ list: domains, total: 2, page: 1, pageSize: 20, totalPages: 1 });
    vi.mocked(deleteDomain).mockResolvedValue({ code: 0, msg: 'success', data: null });
    renderPage();

    await user.click(await screen.findByRole('button', { name: '删除 example.com' }));
    expect(await screen.findByText('删除域名')).toBeTruthy();
    expect(deleteDomain).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(deleteDomain).toHaveBeenCalledWith(1));
  });
});
