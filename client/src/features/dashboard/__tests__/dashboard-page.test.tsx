import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardPage } from '../dashboard-page';
import { fetchDashboard } from '../api';

vi.mock('../api', () => ({ fetchDashboard: vi.fn() }));

const snapshot = {
  domainTotal: 42,
  domains: [
    { id: 1, name: 'example.com', account_id: 1, record_count: 128, expires_at: new Date(Date.now() + 3 * 86400000).toISOString() },
  ],
  accounts: [
    { id: 1, name: '主账号', type: 'aliyun' },
    { id: 2, name: '备用', type: 'cloudflare' },
  ],
  users: [{ id: 1, username: 'admin' }],
  logs: [{ id: 1, action: 'update_record', domain: 'example.com', created_at: new Date().toISOString() }],
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DashboardPage />
    </QueryClientProvider>,
  );
}

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('渲染统计卡、即将到期与提供商分布', async () => {
    vi.mocked(fetchDashboard).mockResolvedValue(snapshot as never);
    renderPage();

    expect(await screen.findByText('42')).toBeTruthy();
    expect(screen.getByText('记录数 128')).toBeTruthy();
    expect(screen.getByText('example.com')).toBeTruthy();
    expect(screen.getByText('阿里云')).toBeTruthy();
    expect(screen.getByText('Cloudflare')).toBeTruthy();
    expect(screen.getByText('修改记录')).toBeTruthy();
  });

  it('加载失败展示错误与重试按钮', async () => {
    vi.mocked(fetchDashboard).mockRejectedValue(new Error('数据库不可达'));
    renderPage();

    expect(await screen.findByText('仪表盘加载失败')).toBeTruthy();
    expect(screen.getByText('数据库不可达')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('非管理员（users/logs 为空）显示受限提示', async () => {
    vi.mocked(fetchDashboard).mockResolvedValue({ ...snapshot, users: null, logs: null } as never);
    renderPage();

    expect((await screen.findAllByText('仅管理员可见')).length).toBeGreaterThan(0);
    expect(screen.getByText('仅管理员可查看操作日志')).toBeTruthy();
  });
});
