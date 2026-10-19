import { describe, it, expect } from 'vitest';
import { DaysLeftDedupe } from './whois-event-dedupe';

describe('WHOIS 到期事件去重', () => {
  it('同到期时间只发布一次', () => {
    const dedupe = new DaysLeftDedupe();
    expect(dedupe.shouldEmit(1, '2026-12-01T00:00:00.000Z')).toBe(true);
    expect(dedupe.shouldEmit(1, '2026-12-01T00:00:00.000Z')).toBe(false);
  });

  it('到期时间变化时再次发布', () => {
    const dedupe = new DaysLeftDedupe();
    expect(dedupe.shouldEmit(1, '2026-12-01T00:00:00.000Z')).toBe(true);
    expect(dedupe.shouldEmit(1, '2027-12-01T00:00:00.000Z')).toBe(true);
  });

  it('剩余天数抖动但到期日不变时不重复发布', () => {
    const dedupe = new DaysLeftDedupe();
    const expires = '2026-12-01T00:00:00.000Z';
    expect(dedupe.shouldEmit(1, expires)).toBe(true);
    expect(dedupe.shouldEmit(1, expires)).toBe(false);
    expect(dedupe.shouldEmit(1, expires)).toBe(false);
  });

  it('不同域名互不影响', () => {
    const dedupe = new DaysLeftDedupe();
    expect(dedupe.shouldEmit(1, '2026-12-01T00:00:00.000Z')).toBe(true);
    expect(dedupe.shouldEmit(2, '2026-12-01T00:00:00.000Z')).toBe(true);
  });

  it('reset 后可重新发布', () => {
    const dedupe = new DaysLeftDedupe();
    dedupe.shouldEmit(1, '2026-12-01T00:00:00.000Z');
    dedupe.reset(1);
    expect(dedupe.shouldEmit(1, '2026-12-01T00:00:00.000Z')).toBe(true);
  });

  it('非法输入不发布', () => {
    const dedupe = new DaysLeftDedupe();
    expect(dedupe.shouldEmit(Number.NaN, '2026-12-01')).toBe(false);
    expect(dedupe.shouldEmit(1, '')).toBe(false);
  });

  it('条目数有上限', () => {
    const dedupe = new DaysLeftDedupe(3);
    for (let i = 0; i < 10; i += 1) dedupe.shouldEmit(i, '2026-12-01T00:00:00.000Z');
    expect(dedupe.size()).toBeLessThanOrEqual(3);
  });
});