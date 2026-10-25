import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemPage } from '../system-page';
import { systemApi } from '../api';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, systemApi: { info: vi.fn(), version: vi.fn() } };
});
vi.mock('../security-tab', () => ({ SystemSecurityTab: () => <div>SECURITY_TAB</div> }));
vi.mock('../access-tab', () => ({ SystemAccessTab: () => <div>ACCESS_TAB</div> }));
vi.mock('../network-tab', () => ({ SystemNetworkTab: () => <div>NETWORK_TAB</div> }));
vi.mock('../workflow-tab', () => ({ SystemWorkflowTab: () => <div>WORKFLOW_TAB</div> }));
vi.mock('../notifications-tab', () => ({ SystemNotificationsTab: () => <div>NOTIFY_TAB</div> }));

function renderPage(activeTab: 'overview' | 'database' | 'security' = 'overview') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SystemPage activeTab={activeTab} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SystemPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(systemApi.info).mockResolvedValue({
      version: '2.2.0',
      serverVersion: '2.2.0',
      database: { type: 'sqlite', version: '3.45.0', driverVersion: 'better-sqlite3 11' },
      timezone: 'Asia/Shanghai',
    });
    vi.mocked(systemApi.version).mockResolvedValue({
      version: '2.2.0', deployMode: 'source', logLevel: 'info', node: 'v22.23.3', uptime: 90061, dbConnected: true,
    });
  });

  it('概述页展示运行状态与版本', async () => {
    renderPage('overview');
    expect(await screen.findByText('系统版本')).toBeTruthy();
    expect((await screen.findAllByText('2.2.0')).length).toBeGreaterThan(0);
    expect(screen.getByText('已连接')).toBeTruthy();
    expect(screen.getByText('1 天 1 小时')).toBeTruthy();
  });

  it('数据库页展示类型与驱动版本，并给出维护提示', async () => {
    renderPage('database');
    expect(await screen.findByText('sqlite')).toBeTruthy();
    expect(screen.getByText('better-sqlite3 11')).toBeTruthy();
    expect(screen.getByText(/修改数据库配置会重建连接/)).toBeTruthy();
  });

  it('标签页导航渲染全部入口，各 tab 组件挂载', async () => {
    renderPage('security');
    for (const label of ['概述', '数据库', '安全', '访问', '网络', '通知', '工作流']) {
      expect(screen.getByRole('link', { name: new RegExp(label) })).toBeTruthy();
    }
    expect(await screen.findByText('SECURITY_TAB')).toBeTruthy();
  });
});
