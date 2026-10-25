import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpPage } from '../mcp-page';
import { mcpApi } from '../api';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    mcpApi: {
      status: vi.fn(),
      globalConfig: vi.fn(),
      setGlobalEnabled: vi.fn(),
      keys: vi.fn(),
      createKey: vi.fn(),
      revokeKey: vi.fn(),
      restoreKey: vi.fn(),
      deleteKey: vi.fn(),
      oauthClients: vi.fn(),
      createOAuthClient: vi.fn(),
      deleteOAuthClient: vi.fn(),
      updateOAuthScope: vi.fn(),
      auditLogs: vi.fn(),
    },
  };
});

const keys = [
  { id: 1, api_key: 'mcp_live_abcdef123456', description: 'Claude Desktop', last_used_at: new Date().toISOString(), expires_at: null, revoked_at: null, created_at: new Date().toISOString() },
  { id: 2, api_key: 'mcp_live_revoked9999', description: '旧客户端', last_used_at: null, expires_at: null, revoked_at: new Date().toISOString(), created_at: new Date().toISOString() },
];
const clients = [
  { id: 1, client_id: 'client-abc', app_name: 'Claude Desktop', redirect_uris: '["http://127.0.0.1:8765/callback"]', scope: 'domain_management:read,ns_monitor:write', created_at: new Date().toISOString() },
];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <McpPage />
    </QueryClientProvider>,
  );
}

describe('McpPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mcpApi.globalConfig).mockResolvedValue({ enabled: true });
    vi.mocked(mcpApi.keys).mockResolvedValue(keys as never);
    vi.mocked(mcpApi.oauthClients).mockResolvedValue(clients as never);
  });

  it('渲染密钥列表：脱敏、状态与最近使用', async () => {
    renderPage();
    expect(await screen.findByText('Claude Desktop')).toBeTruthy();
    expect(screen.getByText('mcp_li…3456')).toBeTruthy();
    expect(screen.getByText('有效')).toBeTruthy();
    expect(screen.getByText('已撤销')).toBeTruthy();
    expect(screen.getByText('恢复')).toBeTruthy();
  });

  it('新增密钥展示一次性明文并可复制', async () => {
    const user = userEvent.setup();
    vi.mocked(mcpApi.createKey).mockResolvedValue({ api_key: 'mcp_live_newkey0123456789' });
    renderPage();

    await user.click(await screen.findByRole('button', { name: /新增 API 密钥/ }));
    await user.type(screen.getByLabelText('说明'), 'CI 客户端');
    await user.click(screen.getByRole('button', { name: '创建' }));

    expect(mcpApi.createKey).toHaveBeenCalledWith({ description: 'CI 客户端', expires_at: null });
    expect(await screen.findByText('mcp_live_newkey0123456789')).toBeTruthy();
    expect(screen.getByText('仅显示一次，请立即保存')).toBeTruthy();
  });

  it('OAuth 客户端展示权限摘要，并可按模块保存 scope', async () => {
    const user = userEvent.setup();
    vi.mocked(mcpApi.updateOAuthScope).mockResolvedValue(undefined as never);
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'OAuth 客户端' }));
    expect(await screen.findByText('NS 监控：读写 · 域名管理：只读')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '权限' }));
    expect(await screen.findByText('配置权限 · Claude Desktop')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mcpApi.updateOAuthScope).toHaveBeenCalledWith('client-abc', 'ns_monitor:write, domain_management:read'));
  });

  it('撤销密钥需二次确认', async () => {
    const user = userEvent.setup();
    vi.mocked(mcpApi.revokeKey).mockResolvedValue({ code: 0, msg: 'success', data: null } as never);
    renderPage();

    await user.click(await screen.findByRole('button', { name: '撤销' }));
    expect(await screen.findByText('撤销 API 密钥')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '确认撤销' }));
    await waitFor(() => expect(mcpApi.revokeKey).toHaveBeenCalledWith(1));
  });
});
