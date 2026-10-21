import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '../contexts/I18nContext';
import { Workflows } from './Workflows';
import { CascadingSelect } from '../components/workflows/CascadingSelect';

const listMock = vi.fn();
const metaMock = vi.fn();
const createMock = vi.fn();
const removeMock = vi.fn();
const updateMock = vi.fn();
const runMock = vi.fn();

vi.mock('../api', () => ({
  workflowsApi: {
    list: () => listMock(),
    meta: (source: string, params?: Record<string, string>) => metaMock(source, params),
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
          // args 要带上必填的 domainId：保存前会做必填校验，空参的动作本来就该被拦
          { id: 1, ownerId: 1, name: 'ok-flow', enabled: true, triggerType: 'record.changed', triggerConfig: { recordTypes: ['A'] }, actions: [{ kind: 'call', action: 'dns.record.list', args: { domainId: { kind: 'literal', value: '1' } } }] },
          { id: 2, ownerId: 1, name: 'bad-flow', enabled: false, triggerType: 'record.changed', triggerConfig: {}, actions: [], corrupted: true },
        ],
      },
    },
  });
  // 统一包装成 axios → ApiResponse → { items } 的形状
  const metaResponse = (items: unknown[]) => ({ data: { data: { items } } });
  metaMock.mockImplementation(async (source: string) => {
    // label 用真实的 i18n key，才能验证页面渲染的是可读名称而不是机器标识符
    if (source === 'actions')
      return metaResponse([
        {
          value: 'dns.record.list',
          label: 'workflow.action.dns_record_list',
          actionClass: 'dns.record.read',
          risk: 'low',
          dslVisible: true,
          params: [{ key: 'domainId', label: 'workflow.param.domain_id', type: 'number', required: true }],
        },
      ]);
    if (source === 'triggerTypes')
      return metaResponse([{ value: 'record.changed', label: 'workflow.trigger.record_changed' }]);
    if (source === 'outboundAllowlist') return metaResponse(['api.ipify.org']);
    return metaResponse([]);
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

  it('列表的触发器列显示可读名称，而不是 record.changed', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('ok-flow')).toBeTruthy());
    await waitFor(() => expect(screen.getAllByText('解析记录变更').length).toBeGreaterThan(0));
    expect(screen.queryByText('record.changed')).toBeNull();
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
describe('工作流页面（人类可读性）', () => {
  it('动作、触发器、参数都显示可读名称，而不是机器标识符', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('ok-flow')).toBeTruthy());
    fireEvent.click(screen.getAllByText('编辑')[0]);
    await waitFor(() => expect(screen.getAllByText('执行条件').length).toBeGreaterThan(0));

    // 参数：有可见的中文标签，不是 domainId
    await waitFor(() => expect(screen.getByText('域名ID')).toBeTruthy());
    expect(screen.queryByText('domainId')).toBeNull();

    // 动作下拉：显示翻译后的名称，不是 dns.record.list
    await waitFor(() => expect(screen.getByDisplayValue('列出解析记录')).toBeTruthy());
    expect(screen.queryByDisplayValue('dns.record.list')).toBeNull();

    // 对话框里不应出现任何机器标识符
    const dialog = document.querySelector('.t-dialog') as HTMLElement;
    expect(dialog.textContent ?? '').not.toContain('dns.record.list');
    expect(dialog.textContent ?? '').not.toContain('record.changed');
  });

  it('运行对话框的字段标签是可读名称', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('ok-flow')).toBeTruthy());
    fireEvent.click(screen.getAllByText('手动运行')[0]);
    await waitFor(() => expect(screen.getAllByText('主机记录').length).toBeGreaterThan(0));
    expect(screen.getByText('记录类型')).toBeTruthy();
    expect(screen.getByText('新记录值')).toBeTruthy();
    expect(screen.getByText('原记录值（用于精确匹配源站）')).toBeTruthy();
    expect(screen.queryByText('record.oldValue')).toBeNull();
  });
});

describe('级联下拉的前置参数', () => {
  function renderCascading(param: Record<string, unknown>, args: Record<string, { kind: 'literal' | 'ref'; value: string }>) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <I18nProvider>
          <CascadingSelect param={param as never} args={args} value="" onChange={() => undefined} />
        </I18nProvider>
      </QueryClientProvider>,
    );
  }

  it('可选前置参数缺失时不禁用下拉，也不把它带给候选接口', async () => {
    metaMock.mockResolvedValue({ data: { data: { items: [] } } });
    const { container } = renderCascading(
      {
        key: 'groupId',
        source: 'originGroups',
        sourceParams: ['domainId'],
        sourceOptionalParams: ['siteType'],
      },
      { domainId: { kind: 'literal', value: '7' } },
    );

    await waitFor(() => expect(metaMock).toHaveBeenCalled());
    const [, passed] = metaMock.mock.calls.at(-1)!;
    expect(passed).toEqual({ domainId: '7' });

    const input = container.querySelector('input') as HTMLInputElement | null;
    expect(input?.disabled).toBe(false);
  });

  it('可选前置参数有值时一并带上', async () => {
    metaMock.mockResolvedValue({ data: { data: { items: [] } } });
    renderCascading(
      {
        key: 'groupId',
        source: 'originGroups',
        sourceParams: ['domainId'],
        sourceOptionalParams: ['siteType'],
      },
      { domainId: { kind: 'literal', value: '7' }, siteType: { kind: 'literal', value: 'intl' } },
    );

    await waitFor(() => expect(metaMock).toHaveBeenCalled());
    const [, passed] = metaMock.mock.calls.at(-1)!;
    expect(passed).toEqual({ domainId: '7', siteType: 'intl' });
  });

  it('必需前置参数缺失时禁用下拉', () => {
    metaMock.mockResolvedValue({ data: { data: { items: [] } } });
    const { container } = renderCascading(
      { key: 'groupId', source: 'originGroups', sourceParams: ['domainId'] },
      {},
    );
    const input = container.querySelector('input') as HTMLInputElement | null;
    expect(input?.disabled).toBe(true);
  });
});

describe('工作流页面（手动运行）', () => {
  it('打开运行对话框后可提交，调用 run 并携带域名', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('ok-flow')).toBeTruthy());
    fireEvent.click(screen.getAllByText('手动运行')[0]);
    // 运行对话框的表单项标签必须是可读名称，不能是 domain / record.name 这类字段名
    await waitFor(() => expect(screen.getAllByText('域名').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('手动运行')[screen.getAllByText('手动运行').length - 1]);
    await waitFor(() => expect(runMock).toHaveBeenCalled());
  });
});