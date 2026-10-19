import { describe, it, expect } from 'vitest';
import { DaysLeftDedupe } from './whois-event-dedupe';

describe('WHOIS 到期事件去重', () => {
  it('同一剩余天数只发布一次', () => {
    const dedupe = new DaysLeftDedupe();
    expect(dedupe.shouldEmit(1, 30)).toBe(true);
    expect(dedupe.shouldEmit(1, 30)).toBe(false);
  });

  it('剩余天数变化时再次发布（withinDays 分级依赖此行为）', () => {
    const dedupe = new DaysLeftDedupe();
    expect(dedupe.shouldEmit(1, 30)).toBe(true);
    expect(dedupe.shouldEmit(1, 7)).toBe(true);
    expect(dedupe.shouldEmit(1, 1)).toBe(true);
  });

  it('不同域名互不影响', () => {
    const dedupe = new DaysLeftDedupe();
    expect(dedupe.shouldEmit(1, 7)).toBe(true);
    expect(dedupe.shouldEmit(2, 7)).toBe(true);
  });

  it('reset 后可重新发布', () => {
    const dedupe = new DaysLeftDedupe();
    dedupe.shouldEmit(1, 7);
    dedupe.reset(1);
    expect(dedupe.shouldEmit(1, 7)).toBe(true);
  });

  it('非法输入不发布', () => {
    const dedupe = new DaysLeftDedupe();
    expect(dedupe.shouldEmit(Number.NaN, 7)).toBe(false);
    expect(dedupe.shouldEmit(1, Number.NaN)).toBe(false);
  });

  it('条目数有上限', () => {
    const dedupe = new DaysLeftDedupe(3);
    for (let i = 0; i < 10; i += 1) dedupe.shouldEmit(i, 5);
    expect(dedupe.size()).toBeLessThanOrEqual(3);
  });
});