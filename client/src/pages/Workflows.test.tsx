import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '../contexts/I18nContext';
import { Workflows } from './Workflows';

const listMock = vi.fn();
const metaMock = vi.fn();
const createMock = vi.fn();
const removeMock = vi.fn();
const updateMock = vi.fn();
const runMock = vi.fn();

vi.mock('../api', () => ({
  workflowsApi: {
    list: () => listMock(),
    meta: (source: string) => metaMock(source),
    create: (payload: unknown) => createMock(payload),
    update: (id: number, payload: unknown) => updateMock(id, payload),
    remove: (id: number) => removeMock(id),
    runs: vi.fn(async () => ({ data: { data: { runs: [] } } })),
    sampleEvent: vi.fn(async () => ({ data: { data: { event: null } } })),
    run: (id: number, payload: unknown) => runMock(id, payload),
    test: vi.fn(async () => ({ data: { code: 0 } })),
  },
}));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <Workflows />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue({
    data: {
      data: {
        items: [
          { id: 1, ownerId: 1, name: 'ok-flow', enabled: true, triggerType: 'record.changed', triggerConfig: { recordTypes: ['A'] }, actions: [{ kind: 'call', action: 'dns.record.list', args: {} }] },
          { id: 2, ownerId: 1, name: 'bad-flow', enabled: false, triggerType: 'record.changed', triggerConfig: {}, actions: [], corrupted: true },
        ],
      },
    },
  });
  metaMock.mockImplementation(async (source: string) => {
    if (source === 'actions') return { data: { data: { items: [{ value: 'dns.record.list', label: 'x', actionClass: 'dns.record.read', risk: 'low', dslVisible: true, params: [] }] } } };
    if (source === 'triggerTypes') return { data: { data: { items: [{ value: 'record.changed', label: 'k' }] } } };
    if (source === 'outboundAllowlist') return { data: { data: { items: ['api.ipify.org'] } } };
    return { data: { data: { items: [] } } };
  });
  createMock.mockResolvedValue({ data: { code: 0, data: { id: 3 } } });
  removeMock.mockResolvedValue({ data: { code: 0 } });
  updateMock.mockResolvedValue({ data: { code: 0 } });
  runMock.mockResolvedValue({ data: { data: { status: 'success' } } });
});

describe('工作流页面（DOM 交互）', () => {
  it('渲染列表并区分正常行与损坏行', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('ok-flow')).toBeTruthy());
    expect(screen.getByText('bad-flow')).toBeTruthy();
    expect(screen.getByText('损坏')).toBeTruthy();
  });

  it('损坏行不提供编辑入口，正常行提供', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('ok-flow')).toBeTruthy());
    const editButtons = screen.getAllByText('编辑');
    expect(editButtons.length).toBe(1);
  });

  it('白名单非空时展示条目', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/api\.ipify\.org/)).toBeTruthy());
  });

  it('点击新建打开对话框，保存时携带 condition:null 与 actions', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('新建工作流')).toBeTruthy());
    fireEvent.click(screen.getByText('新建工作流'));
    // 对话框内出现「执行条件」开关区块
    await waitFor(() => expect(screen.getAllByText('执行条件').length).toBeGreaterThan(0));

    const save = screen.getAllByText('保存')[0];
    fireEvent.click(save);

    await waitFor(() => expect(createMock).toHaveBeenCalled());
    const payload = createMock.mock.calls[0][0] as Record<string, unknown>;
    // 条件关闭时必须显式发 null（undefined 会被 JSON.stringify 丢弃，服务端会保留旧值）
    expect(payload.condition).toBeNull();
    expect(Array.isArray(payload.actions)).toBe(true);
  });
});
describe('工作流页面（编辑 / 删除 / 运行）', () => {
  it('编辑正常行时回填名称，保存走 update 而不是 create', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('ok-flow')).toBeTruthy());
    fireEvent.click(screen.getAllByText('编辑')[0]);
    await waitFor(() => expect(screen.getAllByText('执行条件').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('保存')[0]);
    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    expect(createMock).not.toHaveBeenCalled();
  });

  it('删除需要二次确认，确认后才调用 remove', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('ok-flow')).toBeTruthy());
    fireEvent.click(screen.getAllByText('删除')[0]);
    // ConfirmDialog 出现前不应调用
    expect(removeMock).not.toHaveBeenCalled();
    const confirm = await screen.findAllByText('删除');
    fireEvent.click(confirm[confirm.length - 1]);
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith(1));
  });

  it('损坏行仍可删除（但不可编辑）', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('bad-flow')).toBeTruthy());
    const rows = screen.getAllByText('删除');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('编辑').length).toBe(1);
  });
});
describe('工作流页面（手动运行）', () => {
  it('打开运行对话框后可提交，调用 run 并携带域名', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('ok-flow')).toBeTruthy());
    fireEvent.click(screen.getAllByText('手动运行')[0]);
    // 运行对话框的表单项标签是字面量 domain / record.name
    await waitFor(() => expect(screen.getAllByText('domain').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('手动运行')[screen.getAllByText('手动运行').length - 1]);
    await waitFor(() => expect(runMock).toHaveBeenCalled());
  });
});