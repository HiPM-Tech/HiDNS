import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowsPage } from '../workflows-page';
import * as api from '../workflows-api';
import type { WorkflowActionMeta } from '../workflows-api';

/**
 * 动作构建器的集成用例：走的是真实的对话框 + 真实表单渲染，
 * 只把 HTTP 层（workflowsApi）替换成假数据——
 * 这样才能验证「meta → 表单 → DSL → 保存载荷」整条链路，而不只是转换函数。
 */

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

const ACTIONS: WorkflowActionMeta[] = [
  {
    value: 'dns.record.update',
    label: 'workflow.action.dns_record_update',
    description: 'workflow.actionDesc.dns_record_update',
    actionClass: 'dns.record.write',
    risk: 'medium',
    dslVisible: true,
    params: [
      { key: 'domain', label: 'workflow.param.domain', type: 'text', required: true, suggestSource: 'domainNames' },
      { key: 'recordId', label: 'workflow.param.record_id', type: 'text', required: true, source: 'records', sourceParams: ['domain'] },
      { key: 'value', label: 'workflow.param.value', type: 'text', required: true },
    ],
  },
  {
    value: 'dns.record.create',
    label: 'workflow.action.dns_record_create',
    description: 'workflow.actionDesc.dns_record_create',
    actionClass: 'dns.record.write',
    risk: 'medium',
    dslVisible: true,
    params: [
      { key: 'domain', label: 'workflow.param.domain', type: 'text', required: true, suggestSource: 'domainNames' },
      { key: 'name', label: 'workflow.param.name', type: 'text', required: true },
      { key: 'ttl', label: 'workflow.param.ttl', type: 'number', required: false },
    ],
  },
  {
    value: 'notify.channel.send',
    label: 'workflow.action.notify_channel_send',
    description: 'workflow.actionDesc.notify_channel_send',
    actionClass: 'notify',
    risk: 'low',
    dslVisible: true,
    params: [
      { key: 'title', label: 'workflow.param.title', type: 'text', required: true },
      { key: 'message', label: 'workflow.param.message', type: 'text', required: true },
    ],
  },
];

const TRIGGERS = [
  { value: 'record.changed', label: 'workflow.trigger.record_changed' },
  { value: 'whois.expiring', label: 'workflow.trigger.whois_expiring' },
];

/** 带 params 的触发器声明（对应后端 buildStaticMeta('triggerTypes') 的形状） */
const TRIGGERS_WITH_PARAMS = [
  {
    value: 'record.changed',
    label: 'workflow.trigger.record_changed',
    params: [{ key: 'withinDays', label: '提前天数', type: 'number', required: false }],
  },
  { value: 'whois.expiring', label: 'workflow.trigger.whois_expiring', params: [] },
];

/** 假 meta：按 source 返回声明或候选，记录每次调用的参数 */
function mockMeta() {
  const meta = vi.mocked(api.workflowsApi.meta);
  meta.mockImplementation(async (source: string, query?: Record<string, string>) => {
    if (source === 'actions') return ACTIONS as never;
    if (source === 'triggerTypes') return TRIGGERS as never;
    if (source === 'triggers') throw new Error('未知候选源: triggers'); // 与当前后端一致：没有这个源
    if (source === 'domainNames') return [{ value: 'example.com', label: 'example.com (主账号)' }] as never;
    if (source === 'records') {
      return query?.domain === 'example.com'
        ? [{ value: 'r-1', label: 'www A → 203.0.113.10' }]
        : [];
    }
    return [] as never;
  });
  return meta;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WorkflowsPage />
    </QueryClientProvider>,
  );
}

async function openEditor(row?: Record<string, unknown>) {
  const user = userEvent.setup();
  vi.mocked(api.workflowsApi.list).mockResolvedValue((row ? [row] : []) as never);
  renderPage();
  if (row) await user.click(await screen.findByRole('button', { name: '编辑 演示流' }));
  else await user.click(await screen.findByRole('button', { name: /新增工作流/ }));
  const dialog = await screen.findByRole('dialog');
  return { user, dialog };
}

/** 展开高级 DSL（编辑按钮会同时打开文本框） */
async function openDsl(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '高级：直接编辑动作 DSL' }));
  return screen.getByLabelText('动作 DSL（JSON 数组）') as HTMLTextAreaElement;
}

describe('工作流编辑器 · 动作构建器', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMeta();
    vi.mocked(api.workflowsApi.runs).mockResolvedValue([]);
    vi.mocked(api.workflowsApi.create).mockResolvedValue({ code: 0, data: { id: 1 }, msg: '' } as never);
    vi.mocked(api.workflowsApi.update).mockResolvedValue({ code: 0, data: null, msg: '' } as never);
  });

  it('按 meta 渲染参数，并把填写内容写回动作 DSL', async () => {
    const { user } = await openEditor({
      id: 7,
      name: '演示流',
      enabled: true,
      triggerType: 'record.changed',
      triggerConfig: {},
      actions: [{ kind: 'call', action: 'dns.record.create', args: {} }],
    });

    // 动作名称来自 meta 的 i18n 键，界面显示的是中文而不是 `workflow.action.*` 原文
    expect(await screen.findByRole('combobox', { name: '动作类型' })).toBeTruthy();
    expect(within(screen.getByRole('combobox', { name: '动作类型' })).getByText('新增解析记录')).toBeTruthy();
    expect(screen.getByText('新建一条解析记录')).toBeTruthy();
    expect(screen.getByText('中风险')).toBeTruthy();

    const dsl = await openDsl(user);
    // 空动作还不会产生实参：args 为空对象
    expect(JSON.parse(dsl.value)).toEqual([{ kind: 'call', action: 'dns.record.create', args: {} }]);

    // 文本参数（带联想候选）
    await user.type(screen.getByLabelText(/域名/), 'example.com');
    // 数字参数必须存成 number
    await user.type(screen.getByLabelText(/生存时间/), '300');

    expect((screen.getByLabelText(/生存时间/) as HTMLInputElement).type).toBe('number');

    await waitFor(() => {
      const nodes = JSON.parse(dsl.value) as Array<{ args: Record<string, { value: unknown }> }>;
      expect(nodes[0].args.domain).toEqual({ kind: 'literal', value: 'example.com' });
      expect(nodes[0].args.ttl).toEqual({ kind: 'literal', value: 300 });
    });
  });

  it('级联候选在缺少依赖参数时禁用，并提示先填哪个', async () => {
    // 编辑一条已有工作流：默认展开的动作就是 dns.record.update，才有 `记录 ID` 这个级联参数
    await openEditor({
      id: 7,
      name: '演示流',
      enabled: true,
      triggerType: 'record.changed',
      triggerConfig: {},
      actions: [{ kind: 'call', action: 'dns.record.update', args: {} }],
    });
    const recordSelect = await screen.findByRole('combobox', { name: /记录 ID/ });
    expect(recordSelect.hasAttribute('disabled')).toBe(true);
    expect(recordSelect.textContent).toContain('请先填写依赖参数');
    expect(screen.getByText(/请先填写「域名」/)).toBeTruthy();

    // 依赖没值时不该发起候选请求
    const meta = vi.mocked(api.workflowsApi.meta);
    expect(meta.mock.calls.some(([source]) => source === 'records')).toBe(false);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/域名/), 'example.com');
    await waitFor(() => expect((screen.getByRole('combobox', { name: /记录 ID/ }) as HTMLButtonElement).disabled).toBe(false));
    await waitFor(() => expect(meta.mock.calls.some(([source, query]) => source === 'records' && query?.domain === 'example.com')).toBe(true));
  });

  it('动作可增删与上下移动，顺序即执行顺序', async () => {
    const { user } = await openEditor({
      id: 7,
      name: '演示流',
      enabled: true,
      triggerType: 'record.changed',
      triggerConfig: {},
      actions: [{ kind: 'call', action: 'dns.record.update', args: {} }],
    });
    await screen.findByRole('combobox', { name: '动作类型' });

    // 追加第二个动作（未选类型）
    await user.click(screen.getByRole('button', { name: /添加动作/ }));
    expect(screen.getByText('第 2 个动作还没选动作类型')).toBeTruthy();

    const dsl = await openDsl(user);
    const nodes = () => JSON.parse(dsl.value) as Array<{ action?: string }>;
    expect(nodes()).toHaveLength(2);

    // 上移：第二个（未选类型）排到前面
    await user.click(screen.getByRole('button', { name: '上移第 2 个动作' }));
    expect(nodes()[0].action ?? '').toBe('');
    expect(nodes()[1].action).toBe('dns.record.update');

    // 下移还原
    await user.click(screen.getByRole('button', { name: '下移第 1 个动作' }));
    expect(nodes()[0].action).toBe('dns.record.update');

    // 删除第二个
    await user.click(screen.getByRole('button', { name: '删除第 2 个动作' }));
    expect(nodes()).toHaveLength(1);
    expect(screen.queryByText('第 2 个动作还没选动作类型')).toBeNull();
  });

  it('条件在可视化与 JSON 之间互转，字段不丢', async () => {
    const { user } = await openEditor({
      id: 7,
      name: '演示流',
      enabled: true,
      triggerType: 'record.changed',
      triggerConfig: {},
      condition: {
        kind: 'logic',
        op: 'and',
        args: [
          { kind: 'compare', op: '==', left: { kind: 'ref', path: 'event.record.type' }, right: { kind: 'literal', value: 'A' } },
          { kind: 'compare', op: '<=', left: { kind: 'ref', path: 'event.daysLeft' }, right: { kind: 'literal', value: 30 } },
        ],
      },
      actions: [{ kind: 'call', action: 'notify.channel.send', args: {} }],
    });

    // 已有条件被解析成两行可视化，值按字段类型显示
    expect(await screen.findByLabelText('条件 1 字段')).toBeTruthy();
    expect((screen.getByLabelText('条件 1 值') as HTMLInputElement).value).toBe('A');
    expect((screen.getByLabelText('条件 2 值') as HTMLInputElement).value).toBe('30');

    // 改第一行的值 → 只改这一处，另一条与 and 连接保持不变
    // 用 fireEvent 改值：userEvent 把 "AAAA" 逐字打进受控输入时，`A` 那一步会命中两次 getByLabelText
    fireEvent.change(screen.getByLabelText('条件 1 值'), { target: { value: 'AAAA' } });

    // 切到 JSON 看序列化结果
    await user.click(screen.getByRole('button', { name: 'JSON 高级' }));
    const json = screen.getByLabelText('条件 DSL（JSON，留空表示无条件）') as HTMLTextAreaElement;
    expect(JSON.parse(json.value)).toEqual({
      kind: 'logic',
      op: 'and',
      args: [
        { kind: 'compare', op: '==', left: { kind: 'ref', path: 'event.record.type' }, right: { kind: 'literal', value: 'AAAA' } },
        { kind: 'compare', op: '<=', left: { kind: 'ref', path: 'event.daysLeft' }, right: { kind: 'literal', value: 30 } },
      ],
    });

    // 再从 JSON 改回来，可视化视图跟着变（JSON 是唯一真相）
    const handWritten = {
      kind: 'logic',
      op: 'not',
      args: [{
        kind: 'compare', op: 'in',
        left: { kind: 'ref', path: 'event.record.type' },
        right: { kind: 'literal', value: ['A', 'AAAA'] },
      }],
    };
    fireEvent.change(json, { target: { value: JSON.stringify(handWritten) } });
    await user.click(screen.getByRole('button', { name: '可视化条件' }));
    expect((screen.getByLabelText('条件 1 值') as HTMLInputElement).value).toBe('A, AAAA');
    // 「等价的 DSL」只读区就是把当前 JSON 原样展示，确认可视化没有改写结构
    expect(document.getElementById('wf-condition-peek')?.textContent).toBe(JSON.stringify(handWritten));
  });

  it('触发器 meta 带 params 时渲染表单，否则回退 JSON', async () => {
    // 第一次：后端声明了触发器参数 → 表单
    vi.mocked(api.workflowsApi.meta).mockImplementation(async (source: string) => {
      if (source === 'actions') return ACTIONS as never;
      // 后端契约：触发器声明来自 triggerTypes（历史上这里误写 triggers，服务端没有该源）
      if (source === 'triggerTypes') return TRIGGERS_WITH_PARAMS as never;
      return [] as never;
    });

    const { user, dialog } = await openEditor({
      id: 7,
      name: '演示流',
      enabled: true,
      triggerType: 'record.changed',
      triggerConfig: { withinDays: 7 },
      actions: [{ kind: 'call', action: 'notify.channel.send', args: {} }],
    });

    const field = await within(dialog).findByLabelText('提前天数');
    expect((field as HTMLInputElement).value).toBe('7');
    expect(within(dialog).queryByLabelText('触发器配置（JSON）')).toBeNull();

    await user.clear(field);
    await user.type(field, '15');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.workflowsApi.update).toHaveBeenCalled());
    const payload = vi.mocked(api.workflowsApi.update).mock.calls[0][1];
    expect(payload.triggerConfig).toEqual({ withinDays: 15 });

    // 第二次：meta 里没有触发器声明（当前后端就是如此）→ 回退 JSON 文本域
    mockMeta();
    cleanup();
    const fallback = await openEditor({
      id: 8,
      name: '演示流',
      enabled: true,
      triggerType: 'record.changed',
      triggerConfig: { recordTypes: ['A'] },
      actions: [{ kind: 'call', action: 'notify.channel.send', args: {} }],
    });
    expect(await within(fallback.dialog).findByLabelText('触发器配置（JSON）')).toBeTruthy();
  });

  it('保存时以 DSL 为准并做结构校验', async () => {
    const { user } = await openEditor();
    await screen.findByLabelText('动作 DSL（JSON 数组）', { exact: true }).catch(() => null);
    await user.type(screen.getByLabelText('名称'), '演示流');
    await waitFor(() => expect((screen.getByRole('combobox', { name: '触发器' }) as HTMLButtonElement).textContent).toContain('解析记录变更'));

    const dsl = await openDsl(user);
    // fireEvent 而不是 userEvent.type：JSON 里的 { } [ ] 会被当作键盘描述符解析
    fireEvent.change(dsl, { target: { value: '[{"kind":1}]' } });
    await user.click(screen.getByRole('button', { name: '保存' }));
    // 页面错误条与卡片内的提示都会报同一件事，所以用 getAllByText
    await waitFor(() => expect(screen.getAllByText(/动作 DSL 解析失败/).length).toBeGreaterThan(0));
    expect(api.workflowsApi.create).not.toHaveBeenCalled();

    // 改成合法 DSL 后按原文保存（DSL 是权威表示）
    fireEvent.change(dsl, { target: { value: JSON.stringify([{ kind: 'call', action: 'dns.record.create', args: { name: { kind: 'literal', value: 'www' } } }]) } });
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.workflowsApi.create).toHaveBeenCalled());
    const payload = vi.mocked(api.workflowsApi.create).mock.calls[0][0];
    expect(payload.actions).toEqual([{ kind: 'call', action: 'dns.record.create', args: { name: { kind: 'literal', value: 'www' } } }]);
    expect(payload.triggerType).toBe('record.changed');
    expect(payload.condition).toBeNull();
  });
});