import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '../../contexts/I18nContext';
import { WorkflowTab } from './WorkflowTab';

const getMock = vi.fn();
const updateMock = vi.fn();

vi.mock('../../api', () => ({
  settingsApi: {
    getWorkflowHttpAllowlist: () => getMock(),
    updateWorkflowHttpAllowlist: (list: string[]) => updateMock(list),
  },
}));

vi.mock('../../hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <WorkflowTab />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  updateMock.mockReset();
  getMock.mockResolvedValue({ data: { data: { allowlist: ['api.ipify.org', '*.cloudflare.com'] } } });
});

describe('WorkflowTab', () => {
  it('展示服务端返回的当前白名单条目', async () => {
    renderTab();
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(await screen.findByText('api.ipify.org')).toBeTruthy();
    expect(screen.getByText('*.cloudflare.com')).toBeTruthy();
  });

  it('明确提示空白名单是 fail-closed 而不是放行', async () => {
    renderTab();
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    // 这句语义最容易被误解，必须在界面上说清楚
    expect(screen.getByText(/fail-closed/)).toBeTruthy();
  });

  it('初始加载不会调用更新接口', async () => {
    renderTab();
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(updateMock).not.toHaveBeenCalled();
  });
});
