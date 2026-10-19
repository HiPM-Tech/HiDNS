import { describe, it, expect, vi } from 'vitest';
import { createCachedLoader } from '../cache';

describe('带 TTL 的惰性缓存', () => {
  it('TTL 内复用，过期后重新加载', async () => {
    let clock = 1000;
    const loader = vi.fn(async () => ['v1']);
    const cache = createCachedLoader(loader, { ttlMs: 5000, now: () => clock });

    await cache.get();
    clock += 4000;
    await cache.get();
    expect(loader).toHaveBeenCalledTimes(1);

    clock += 2000;
    await cache.get();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('invalidate 后立即重新加载', async () => {
    let value = 1;
    const loader = vi.fn(async () => value++);
    const cache = createCachedLoader(loader, { ttlMs: 60_000, now: () => 0 });
    expect(await cache.get()).toBe(1);
    cache.invalidate();
    expect(await cache.get()).toBe(2);
  });

  it('并发请求合并为一次加载', async () => {
    let resolve!: (value: string[]) => void;
    const loader = vi.fn(() => new Promise<string[]>((r) => { resolve = r; }));
    const cache = createCachedLoader(loader, { ttlMs: 60_000, now: () => 0 });

    const a = cache.get();
    const b = cache.get();
    resolve(['x']);
    expect(await a).toEqual(['x']);
    expect(await b).toEqual(['x']);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('加载失败不污染缓存，下次仍会重试', async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(['ok']);
    const cache = createCachedLoader(loader as never, { ttlMs: 60_000, now: () => 0 });
    await expect(cache.get()).rejects.toThrow('boom');
    expect(await cache.get()).toEqual(['ok']);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('失效期间完成的加载不回填（失效代数）', async () => {
    let resolve!: (value: string[]) => void;
    const loader = vi.fn(() => new Promise<string[]>((r) => { resolve = r; }));
    const cache = createCachedLoader(loader, { ttlMs: 60_000, now: () => 0 });

    const pending = cache.get();
    cache.invalidate();
    resolve(['stale']);
    await pending;

    // 下一次必须重新加载，而不是命中失效前的结果
    const second = cache.get();
    resolve(['fresh']);
    expect(await second).toEqual(['fresh']);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('统计命中与未命中', async () => {
    const cache = createCachedLoader(async () => 1, { ttlMs: 60_000, now: () => 0 });
    await cache.get();
    await cache.get();
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().misses).toBe(1);
  });
});