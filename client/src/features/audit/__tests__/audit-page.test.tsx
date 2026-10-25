import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditPage } from '../audit-page';
import { listAuditLogs } from '../api';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, listAuditLogs: vi.fn() };
});

const rows = [
  { id: 1, username: 'admin', nickname: '管理员', action: 'update_record', domain: 'example.com', data: '{"name":"www","type":"A"}', created_at: new Date().toISOString() },
  { id: 2, username: 'ops', action: 'delete_domain', domain: 'demo.org', data: null, created_at: new Date(Date.now() - 3600000).toISOString() },
  { id: 3, username: 'ops', action: 'custom_unknown_action', domain: null, data: 'raw-text', created_at: new Date().toISOString() },
];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuditPage />
    </QueryClientProvider>,
  );
}

describe('AuditPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('渲染审计行、中文动作标签与详情摘要', async () => {
    vi.mocked(listAuditLogs).mockResolvedValue({ total: 3, list: rows as never });
    renderPage();

    expect(await screen.findByText('修改记录')).toBeTruthy();
    expect(screen.getByText('删除域名')).toBeTruthy();
    expect(screen.getByText('example.com')).toBeTruthy();
    expect(screen.getByText('name: www · type: A')).toBeTruthy();
    expect(screen.getByText('共 3 条记录')).toBeTruthy();
  });

  it('未登记动作原样展示，不吞成裸 key', async () => {
    vi.mocked(listAuditLogs).mockResolvedValue({ total: 1, list: [rows[2]] as never });
    renderPage();
    expect(await screen.findByText('custom_unknown_action')).toBeTruthy();
  });

  it('空列表提示，并按筛选条件请求', async () => {
    vi.mocked(listAuditLogs).mockResolvedValue({ total: 0, list: [] });
    renderPage();
    expect(await screen.findByText('没有符合条件的审计记录')).toBeTruthy();

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('操作（如 add_record）'), 'login');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(vi.mocked(listAuditLogs).mock.calls.some(([query]) => (query as { action?: string }).action === 'login')).toBe(true);
  });
});
