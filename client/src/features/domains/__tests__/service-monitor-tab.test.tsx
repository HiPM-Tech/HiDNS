import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceMonitorTab } from '../service-monitor-tab';
import { serviceMonitorApi } from '../service-monitor-api';

vi.mock('../service-monitor-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../service-monitor-api')>();
  return {
    ...actual,
    serviceMonitorApi: {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      check: vi.fn(),
      availableDomains: vi.fn(),
    },
  };
});

const rows = [
  { id: 1, name: 'example.com 证书', monitor_type: 'ssl_certificate', target: 'example.com', monitor_type_ok: true, check_interval: 300, status: 'healthy', last_check_at: new Date(Date.now() - 300000).toISOString(), response_time: 128, result_data: { daysUntilExpiry: 12 } },
  { id: 2, name: 'acme.net 端点', monitor_type: 'endpoint', target: 'https://acme.net/health', check_interval: 600, status: 'down', last_check_at: null, response_time: null },
];

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ServiceMonitorTab />
    </QueryClientProvider>,
  );
}

describe('ServiceMonitorTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(serviceMonitorApi.availableDomains).mockResolvedValue([{ id: 5, name: 'example.com' }]);
  });

  it('渲染监控列表、状态与证书剩余天数', async () => {
    vi.mocked(serviceMonitorApi.list).mockResolvedValue({ list: rows as never, total: 2 });
    renderTab();

    expect(await screen.findByText('example.com 证书')).toBeTruthy();
    expect(screen.getByText('证书剩余 12 天')).toBeTruthy();
    expect(screen.getByText('正常')).toBeTruthy();
    expect(screen.getAllByText(/2 条/).length).toBeGreaterThan(0);
    expect(vi.mocked(serviceMonitorApi.list).mock.calls[0][0]).toMatchObject({ type: 'ssl_certificate', page: 1 });
  });

  it('切换类型按新类型请求', async () => {
    const user = userEvent.setup();
    vi.mocked(serviceMonitorApi.list).mockResolvedValue({ list: [], total: 0 });
    renderTab();

    await user.click(await screen.findByRole('button', { name: '端点探测' }));
    await waitFor(() => expect(vi.mocked(serviceMonitorApi.list).mock.calls.at(-1)?.[0]).toMatchObject({ type: 'endpoint', page: 1 }));
    expect(await screen.findByText('还没有 端点探测 监控')).toBeTruthy();
  });

  it('检测调用后端并提示完成', async () => {
    const user = userEvent.setup();
    vi.mocked(serviceMonitorApi.list).mockResolvedValue({ list: rows as never, total: 2 });
    vi.mocked(serviceMonitorApi.check).mockResolvedValue({ ok: true });
    renderTab();

    const buttons = await screen.findAllByRole('button', { name: /检测/ });
    await user.click(buttons[0]);
    await waitFor(() => expect(serviceMonitorApi.check).toHaveBeenCalledWith(1));
    expect(await screen.findByText(/检测完成/)).toBeTruthy();
  });

  it('删除需要二次确认', async () => {
    const user = userEvent.setup();
    vi.mocked(serviceMonitorApi.list).mockResolvedValue({ list: rows as never, total: 2 });
    vi.mocked(serviceMonitorApi.remove).mockResolvedValue(undefined as never);
    renderTab();

    await user.click(await screen.findByRole('button', { name: '删除 example.com 证书' }));
    expect(await screen.findByText('删除监控')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(serviceMonitorApi.remove).toHaveBeenCalledWith(1));
  });
});
