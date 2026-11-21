import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ExpiryBucketsChart } from '../charts';

const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

describe('到期分布图', () => {
  it('已过期的域名单独落桶，不再混进「≤30 天」', () => {
    const { container } = render(
      <ExpiryBucketsChart expiresAt={[daysFromNow(-200), daysFromNow(10), daysFromNow(60), daysFromNow(400)]} />,
    );
    // 6 个桶：已过期 / ≤30 / 31-90 / 91-180 / 181-365 / >365
    expect(container.querySelectorAll('rect')).toHaveLength(6);
  });

  it('没有数据时也能渲染', () => {
    const { container } = render(<ExpiryBucketsChart expiresAt={[]} />);
    expect(container.querySelectorAll('rect')).toHaveLength(6);
  });
});