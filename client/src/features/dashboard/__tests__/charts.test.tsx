import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProviderShareChart, ExpiryBucketsChart } from '../charts';

vi.mock('../../../lib/http', () => ({ http: { get: vi.fn(async () => ({ code: 0, data: { total: 0, list: [] } })) } }));

describe('仪表盘图表', () => {
  it('提供商占比渲染每个提供商的占比条', () => {
    const { container } = render(
      <ProviderShareChart items={[
        { type: 'cloudflare', count: 3, percent: 60 },
        { type: 'aliyun', count: 2, percent: 40 },
      ]} />,
    );
    expect(screen.getByText('cloudflare')).toBeTruthy();
    expect(screen.getByText(/3 个 · 60%/)).toBeTruthy();
    expect(container.querySelectorAll('.h-full.rounded-full')).toHaveLength(2);
  });

  it('没有账号时给出空态文案', () => {
    render(<ProviderShareChart items={[]} />);
    expect(screen.getByText('暂无账号')).toBeTruthy();
  });

  it('到期分布把域名分到 5 个桶里', () => {
    const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
    const { container } = render(
      <ExpiryBucketsChart expiresAt={[daysFromNow(10), daysFromNow(60), daysFromNow(60), daysFromNow(400), null]} />,
    );
    // 5 个柱子（含 0 计数也会画 rect）
    expect(container.querySelectorAll('rect')).toHaveLength(5);
    expect(screen.getByText('2')).toBeTruthy();   // 31-90 天桶有 2 个
  });
});