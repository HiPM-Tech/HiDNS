import { describe, it, expect } from 'vitest';
import { PruneScheduler } from './retention';

describe('运行记录保留调度', () => {
  it('每 every 次写入触发一次清理', () => {
    const scheduler = new PruneScheduler({ keep: 10, every: 3 });
    expect(scheduler.onInsert(1)).toBe(false);
    expect(scheduler.onInsert(1)).toBe(false);
    expect(scheduler.onInsert(1)).toBe(true);
    expect(scheduler.onInsert(1)).toBe(false);
  });

  it('不同工作流计数独立', () => {
    const scheduler = new PruneScheduler({ keep: 10, every: 2 });
    expect(scheduler.onInsert(1)).toBe(false);
    expect(scheduler.onInsert(2)).toBe(false);
    expect(scheduler.onInsert(1)).toBe(true);
    expect(scheduler.onInsert(2)).toBe(true);
  });

  it('非法工作流 ID 不计数', () => {
    const scheduler = new PruneScheduler({ keep: 10, every: 1 });
    expect(scheduler.onInsert(0)).toBe(false);
    expect(scheduler.onInsert(Number.NaN)).toBe(false);
  });

  it('keep 可读取，reset 后重新计数', () => {
    const scheduler = new PruneScheduler({ keep: 42, every: 2 });
    expect(scheduler.keep()).toBe(42);
    scheduler.onInsert(1);
    scheduler.reset();
    expect(scheduler.onInsert(1)).toBe(false);
  });
});