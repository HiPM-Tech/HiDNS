import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '../../contexts/I18nContext';
import { CascadingSelect, formatCandidateLabel } from './CascadingSelect';

/** 只替换需要的两个占位符，其余原样返回 */
const fakeT = (key: string, options?: Record<string, string | number>) => {
  if (key === 'workflows.originGroupCounts') return `${options?.records} 条源站 · ${options?.references} 处引用`;
  return key;
};

const metaMock = vi.fn();
vi.mock('../../api', () => ({
  workflowsApi: { meta: (source: string, params?: Record<string, string>) => metaMock(source, params) },
}));

function renderSelect(_items: unknown[], value = '') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <CascadingSelect
          param={{ key: 'groupId', source: 'originGroups' } as never}
          args={{}}
          value={value}
          onChange={() => undefined}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  metaMock.mockReset();
});

describe('源站组候选的条数与引用数（设计 §1106）', () => {
  it('选项标签里带上源站条数与引用方数量', () => {
    // 纯函数直接测：展开 TDesign 下拉在 jsdom 里不稳定，标签拼装本身是纯逻辑
    expect(formatCandidateLabel({ label: '主源站', records: 3, references: 2 }, fakeT)).toBe(
      '主源站 · 3 条源站 · 2 处引用',
    );
  });

  it('没有计数信息时标签保持原样', () => {
    expect(formatCandidateLabel({ label: '某域名' }, fakeT)).toBe('某域名');
  });

  it('选中的组条数 > 1 时提示会被收敛成 1 条', async () => {
    metaMock.mockResolvedValue({
      data: { data: { items: [{ value: 'g1', label: '主源站', records: 3, references: 0 }] } },
    });
    renderSelect([], 'g1');
    expect(await screen.findByText(/会把 3 条源站收敛为 1 条/)).toBeTruthy();
  });

  it('条数为 1 时不提示', async () => {
    metaMock.mockResolvedValue({
      data: { data: { items: [{ value: 'g1', label: '主源站', records: 1, references: 0 }] } },
    });
    renderSelect([], 'g1');
    await waitFor(() => expect(metaMock).toHaveBeenCalled());
    expect(screen.queryByText(/收敛为 1 条/)).toBeNull();
  });

  it('候选拉取失败时显示服务端给的原因，而不是空下拉', async () => {
    // 例如账号类型不支持源站组：服务端会返回可读的 502，界面必须转述出来
    metaMock.mockRejectedValue({
      response: { data: { msg: '不允许复用「aliyun」提供商的凭据调用 EdgeOne' } },
    });
    renderSelect([], '');
    expect(await screen.findByText(/不允许复用/)).toBeTruthy();
  });
});
