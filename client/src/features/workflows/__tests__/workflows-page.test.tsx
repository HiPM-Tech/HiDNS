import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowsPage } from '../workflows-page';
import * as api from '../workflows-api';

vi.mock('../workflows-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workflows-api')>();
  return {
    ...actual,
    workflowsApi: {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      runs: vi.fn(),
      test: vi.fn(),
      run: vi.fn(),
      sampleEvent: vi.fn(),
      meta: vi.fn(),
    },
  };
});

const rows = [
  { id: 1, name: '证书到期通知', enabled: true, triggerType: 'cert_expiring', triggerConfig: {}, actions: [{ kind: 'notify.email', to: 'ops@example.com' }] },
  { id: 2, name: '损坏行', enabled: false, triggerType: 'record_created', actions: [], corrupted: true },
];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WorkflowsPage />
    </QueryClientProvider>,
  );
}

describe('WorkflowsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.workflowsApi.meta).mockResolvedValue([{ value: 'cert_expiring', label: '证书即将到期' }]);
    vi.mocked(api.workflowsApi.runs).mockResolvedValue([]);
  });

  it('渲染工作流列表、动作徽标与损坏行提示', async () => {
    vi.mocked(api.workflowsApi.list).mockResolvedValue(rows as never);
    renderPage();

    expect(await screen.findByText('证书到期通知')).toBeTruthy();
    expect(screen.getByText('notify.email')).toBeTruthy();
    expect(screen.getByText('该行无法解析，只能删除')).toBeTruthy();
    expect((screen.getByRole('button', { name: '编辑 损坏行' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('检查动作配置并显示问题列表', async () => {
    const user = userEvent.setup();
    vi.mocked(api.workflowsApi.list).mockResolvedValue(rows as never);
    vi.mocked(api.workflowsApi.test).mockResolvedValue({ ok: false, issues: ['缺少收件人'] });
    renderPage();

    const buttons = await screen.findAllByRole('button', { name: /检查/ });
    await user.click(buttons[0]);
    expect(await screen.findByText('配置存在问题：缺少收件人')).toBeTruthy();
  });

  it('新增工作流时动作 DSL 解析失败会拦截', async () => {
    const user = userEvent.setup();
    vi.mocked(api.workflowsApi.list).mockResolvedValue([] as never);
    renderPage();

    await user.click(await screen.findByRole('button', { name: /新增工作流/ }));
    await user.type(screen.getByLabelText('名称'), '测试流');
    // 动作 DSL 现在收在「高级」里，展开后才是 textarea
    await user.click(screen.getByRole('button', { name: '高级：直接编辑动作 DSL' }));
    const actions = screen.getByLabelText('动作 DSL（JSON 数组）');
    // 用 fireEvent 写值：userEvent.type 会把 { } 当成键盘描述符解析
    fireEvent.change(actions, { target: { value: '[{"kind":1}]' } });
    await waitFor(() => expect((screen.getByRole('combobox', { name: '触发器' }) as HTMLButtonElement).textContent).toContain('证书即将到期'));
    await user.click(screen.getByRole('button', { name: '保存' }));

    // 页面错误条与卡片内提示都会报同一件事
    await waitFor(() => expect(screen.getAllByText(/动作 DSL 解析失败/).length).toBeGreaterThan(0));
    expect(api.workflowsApi.create).not.toHaveBeenCalled();
  });

  it('运行记录展示状态与 traceId', async () => {
    const user = userEvent.setup();
    vi.mocked(api.workflowsApi.list).mockResolvedValue(rows as never);
    vi.mocked(api.workflowsApi.runs).mockResolvedValue([
      { id: 9, workflow_id: 1, trace_id: 'trace-abc', status: 'failed', error: 'smtp 连接失败', started_at: new Date().toISOString() },
    ] as never);
    renderPage();

    const buttons = await screen.findAllByRole('button', { name: /记录/ });
    await user.click(buttons[0]);
    expect(await screen.findByText('运行记录 · 证书到期通知')).toBeTruthy();
    expect(screen.getByText('trace-abc')).toBeTruthy();
    expect(screen.getByText('smtp 连接失败')).toBeTruthy();
  });
});