import { describe, expect, it } from 'vitest';
import { withDomainLock } from '../domain-lock';

/**
 * 共享域名锁：Spaceship 的 PUT 与 Dynadot 的 set_dns2 都是「全量保存」，
 * 同域名的读-改-写必须串行，否则后写覆盖前写（lost update）。
 */
describe('withDomainLock', () => {
  function trackedTask(key: string, state: { inFlight: number; max: number }) {
    return withDomainLock(key, async () => {
      state.inFlight += 1;
      state.max = Math.max(state.max, state.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      state.inFlight -= 1;
    });
  }

  it('同一域名串行：任何时刻只有一个任务在执行', async () => {
    const state = { inFlight: 0, max: 0 };
    await Promise.all([
      trackedTask('example.com', state),
      trackedTask('example.com', state),
      trackedTask('EXAMPLE.COM', state),   // 大小写不敏感，视为同一域名
    ]);
    expect(state.max).toBe(1);
  });

  it('不同域名互不阻塞', async () => {
    const state = { inFlight: 0, max: 0 };
    await Promise.all([
      trackedTask('a.example.com', state),
      trackedTask('b.example.com', state),
    ]);
    expect(state.max).toBe(2);
  });

  it('前一个任务失败后，队列继续执行', async () => {
    const order: string[] = [];
    const failing = withDomainLock('fail.example.com', async () => {
      order.push('first');
      throw new Error('boom');
    });
    const next = withDomainLock('fail.example.com', async () => {
      order.push('second');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
    expect(order).toEqual(['first', 'second']);
  });

  it('空 key 退化为同一个默认队列', async () => {
    const state = { inFlight: 0, max: 0 };
    await Promise.all([
      trackedTask('', state),
      trackedTask('', state),
    ]);
    expect(state.max).toBe(1);
  });
});