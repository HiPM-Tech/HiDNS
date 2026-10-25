import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordsPage } from '../records-page';
import { createRecord, deleteRecord, getDomainDetail, listRecordLines, listRecords, listRecordTypes } from '../api';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    listRecords: vi.fn(),
    listRecordLines: vi.fn(),
    listRecordTypes: vi.fn(),
    getDomainDetail: vi.fn(),
    createRecord: vi.fn(),
    updateRecord: vi.fn(),
    deleteRecord: vi.fn(),
    setRecordStatus: vi.fn(),
  };
});
const domainAccountsMock: { data: Array<{ id: number; name: string; type: string }> } = {
  data: [{ id: 1, name: '阿里云', type: 'aliyun' }],
};
vi.mock('../../domains/use-domains', () => ({
  useDomainAccounts: () => ({ data: domainAccountsMock.data, isLoading: false }),
}));

const rows = [
  { id: 'r1', name: 'www', type: 'A', value: '1.2.3.4', line: 'default', ttl: 600, status: 1, remark: '主站' },
  { id: 'r2', name: 'mail', type: 'MX', value: 'mail.example.com', line: 'Dianxin', ttl: 3600, status: 0, mx: 10 },
];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/dash/domains/7/records']}>
        <Routes>
          <Route path="/dash/domains/:id/records" element={<RecordsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RecordsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDomainDetail).mockResolvedValue({ id: 7, name: 'example.com', account_id: 1 });
    vi.mocked(listRecordLines).mockResolvedValue([{ id: 'default', name: '全网默认' }, { id: 'Dianxin', name: '电信' }]);
    vi.mocked(listRecordTypes).mockResolvedValue(['A', 'MX', 'TXT']);
  });

  it('渲染记录行、线路名与状态', async () => {
    vi.mocked(listRecords).mockResolvedValue({ total: 2, list: rows as never });
    renderPage();

    expect(await screen.findByText('example.com')).toBeTruthy();
    expect(screen.getByText('www')).toBeTruthy();
    expect(screen.getByText('1.2.3.4')).toBeTruthy();
    expect(screen.getByText('mail')).toBeTruthy();
    expect(screen.getByText('已启用')).toBeTruthy();
    expect(screen.getByText('已停用')).toBeTruthy();
    expect(screen.getByText('共 2 条记录')).toBeTruthy();
  });

  it('空列表给出提示', async () => {
    vi.mocked(listRecords).mockResolvedValue({ total: 0, list: [] });
    renderPage();
    expect(await screen.findByText('还没有解析记录')).toBeTruthy();
  });

  it('新增记录：填写表单后调用 createRecord', async () => {
    const user = userEvent.setup();
    vi.mocked(listRecords).mockResolvedValue({ total: 0, list: [] });
    vi.mocked(createRecord).mockResolvedValue({ code: 0, msg: 'success', data: { id: 'new' } });
    renderPage();

    await user.click(await screen.findByRole('button', { name: /新增记录/ }));
    const nameInput = screen.getByLabelText('主机记录');
    await user.clear(nameInput);
    await user.type(nameInput, 'api');
    await user.type(screen.getByLabelText('记录值'), '5.6.7.8');
    await user.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => expect(createRecord).toHaveBeenCalledTimes(1));
    const [domainId, payload] = vi.mocked(createRecord).mock.calls[0];
    expect(domainId).toBe(7);
    expect(payload).toMatchObject({ name: 'api', type: 'A', value: '5.6.7.8' });
  });

  it('支持代理的提供商：代理开关随记录一起提交（P1 回归守卫）', async () => {
    const user = userEvent.setup();
    domainAccountsMock.data = [{ id: 1, name: 'Cloudflare', type: 'cloudflare' }];
    vi.mocked(listRecords).mockResolvedValue({ total: 0, list: [] });
    vi.mocked(createRecord).mockResolvedValue({ code: 0, msg: 'success', data: { id: 'p1' } });
    renderPage();

    await user.click(await screen.findByRole('button', { name: /新增记录/ }));
    const nameInput = screen.getByLabelText('主机记录');
    await user.clear(nameInput);
    await user.type(nameInput, 'www');
    await user.type(screen.getByLabelText('记录值'), '1.1.1.1');
    await user.click(screen.getByRole('switch', { name: '开启代理' }));
    await user.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => expect(createRecord).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createRecord).mock.calls[0][1]).toMatchObject({ name: 'www', proxied: true });
    domainAccountsMock.data = [{ id: 1, name: '阿里云', type: 'aliyun' }];
  });

  it('删除记录需要二次确认', async () => {
    const user = userEvent.setup();
    vi.mocked(listRecords).mockResolvedValue({ total: 2, list: rows as never });
    vi.mocked(deleteRecord).mockResolvedValue({ code: 0, msg: 'success', data: null });
    renderPage();

    await user.click(await screen.findByRole('button', { name: '删除 www' }));
    expect(await screen.findByText('删除记录')).toBeTruthy();
    expect(deleteRecord).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(deleteRecord).toHaveBeenCalledWith(7, 'r1'));
  });
});
