import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemWorkflowTab } from '../workflow-tab';
import { SystemNotificationsTab } from '../notifications-tab';
import { systemNetworkApi } from '../network-api';

vi.mock('../network-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../network-api')>();
  return {
    ...actual,
    systemNetworkApi: {
      ...actual.systemNetworkApi,
      allowlist: vi.fn(),
      updateAllowlist: vi.fn(),
      channels: vi.fn(),
      updateChannels: vi.fn(),
    },
  };
});

function wrap(node: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe('SystemWorkflowTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('空白名单给出「禁止一切出站」提示，添加后保存', async () => {
    const user = userEvent.setup();
    vi.mocked(systemNetworkApi.allowlist).mockResolvedValue([]);
    vi.mocked(systemNetworkApi.updateAllowlist).mockResolvedValue({ code: 0, msg: 'success', data: null });
    wrap(<SystemWorkflowTab />);

    expect(await screen.findByText(/工作流的出站请求会被全部拒绝/)).toBeTruthy();
    await user.type(screen.getByLabelText('新增主机名'), 'api.example.com');
    await user.click(screen.getByRole('button', { name: '添加' }));
    await user.click(screen.getByRole('button', { name: '保存白名单' }));

    await waitFor(() => expect(systemNetworkApi.updateAllowlist).toHaveBeenCalledWith(['api.example.com']));
  });

  it('拒绝带 scheme/端口的条目', async () => {
    const user = userEvent.setup();
    vi.mocked(systemNetworkApi.allowlist).mockResolvedValue([]);
    wrap(<SystemWorkflowTab />);

    await user.type(await screen.findByLabelText('新增主机名'), 'https://api.example.com:443');
    await user.click(screen.getByRole('button', { name: '添加' }));
    expect(await screen.findByText(/只能填写主机名/)).toBeTruthy();
  });
});

describe('SystemNotificationsTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('展示渠道并可切换启用状态', async () => {
    const user = userEvent.setup();
    vi.mocked(systemNetworkApi.channels).mockResolvedValue([
      { id: 'c1', type: 'webhook', name: '运维 Webhook', enabled: true, config: { url: 'https://hook.example.com', method: 'POST' } },
    ]);
    vi.mocked(systemNetworkApi.updateChannels).mockResolvedValue({ code: 0, msg: 'success', data: null });
    wrap(<SystemNotificationsTab />);

    expect(await screen.findByText('运维 Webhook')).toBeTruthy();
    expect(screen.getByText('Webhook')).toBeTruthy();
    await user.click(screen.getByRole('switch', { name: '运维 Webhook 启用状态' }));

    await waitFor(() => expect(systemNetworkApi.updateChannels).toHaveBeenCalled());
    expect(vi.mocked(systemNetworkApi.updateChannels).mock.calls[0][0][0].enabled).toBe(false);
  });
});
