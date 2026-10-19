import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '../contexts/I18nContext';
import { Workflows } from './Workflows';
import { MessagePlugin } from 'tdesign-react';

const listMock = vi.fn();
const metaMock = vi.fn();
const createMock = vi.fn();
const removeMock = vi.fn();

vi.mock('../api', () => ({
  workflowsApi: {
    list: () => listMock(),
    meta: (source: string) => metaMock(source),
    create: (payload: unknown) => createMock(payload),
    update: vi.fn(async () => ({ data: { code: 0 } })),
    remove: (id: number) => removeMock(id),
    runs: vi.fn(async () => ({ data: { data: { runs: [] } } })),
    sampleEvent: vi.fn(async () => ({ data: { data: { event: null } } })),
    run: vi.fn(async () => ({ data: { data: { status: 'success' } } })),
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
  // MessagePlugin 需要真实 DOM 渲染器，测试里静音即可
  vi.spyOn(MessagePlugin, 'success').mockImplementation((() => undefined) as never);
  vi.spyOn(MessagePlugin, 'error').mockImplementation((() => undefined) as never);
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