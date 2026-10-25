import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsMonitorTab } from '../ns-monitor-tab';
import * as api from '../ns-monitor-api';

vi.mock('../ns-monitor-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ns-monitor-api')>();
  return {
    ...actual,
    listNsMonitors: vi.fn(),
    listAvailableDomains: vi.fn(),
    addNsMonitor: vi.fn(),
    updateNsMonitor: vi.fn(),
    deleteNsMonitor: vi.fn(),
    checkNsRecord: vi.fn(),
    resolveNs: vi.fn(),
  };
});

const rows = [
  { id: 1, domain_id: 3, domain_name: 'example.com', expected_ns: 'ns1.example.com,ns2.example.com', enabled: 1, status: 'ok', last_check_at: new Date(Date.now() - 600000).toISOString(), alert_count: 0 },
  { id: 2, domain_id: 4, domain_name: 'acme.net', expected_ns: 'ns1.acme.net', enabled: 1, status: 'mismatch', last_check_at: new Date(Date.now() - 3600000).toISOString(), alert_count: 3 },
];

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NsMonitorTab />
    </QueryClientProvider>,
  );
}

describe('NsMonitorTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listAvailableDomains).mockResolvedValue([{ id: 3, name: 'example.com', account_id: 1 }]);
  });

  it('渲染监控项、NS 列表与状态', async () => {
    vi.mocked(api.listNsMonitors).mockResolvedValue({ list: rows as never, total: 2 });
    renderTab();

    expect(await screen.findByText('example.com')).toBeTruthy();
    expect(screen.getByText('ns1.example.com · ns2.example.com')).toBeTruthy();
    expect(screen.getByText('正常')).toBeTruthy();
    expect(screen.getByText('不一致')).toBeTruthy();
    expect(screen.getByText('3 次')).toBeTruthy();
    expect(screen.getAllByText(/2 条/).length).toBeGreaterThan(0);
  });

  it('检测按钮调用 check 并展示结果提示', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listNsMonitors).mockResolvedValue({ list: rows as never, total: 2 });
    vi.mocked(api.checkNsRecord).mockResolvedValue({ current_ns: ['ns1.example.com'], expected_ns: ['ns1.example.com'], status: 'ok' });
    renderTab();

    const buttons = await screen.findAllByRole('button', { name: /检测/ });
    await user.click(buttons[0]);
    await waitFor(() => expect(api.checkNsRecord).toHaveBeenCalledWith('example.com'));
    expect(await screen.findByText(/检测完成：正常/)).toBeTruthy();
  });

  it('启用开关调用 update', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listNsMonitors).mockResolvedValue({ list: rows as never, total: 2 });
    vi.mocked(api.updateNsMonitor).mockResolvedValue(undefined);
    renderTab();

    await user.click(await screen.findByRole('switch', { name: '启用 example.com' }));
    await waitFor(() => expect(api.updateNsMonitor).toHaveBeenCalledWith(1, { enabled: false }));
  });

  it('删除需要二次确认', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listNsMonitors).mockResolvedValue({ list: rows as never, total: 2 });
    vi.mocked(api.deleteNsMonitor).mockResolvedValue(undefined);
    renderTab();

    await user.click(await screen.findByRole('button', { name: '删除 example.com' }));
    expect(await screen.findByText('删除 NS 监控')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(api.deleteNsMonitor).toHaveBeenCalledWith(1));
  });
});
