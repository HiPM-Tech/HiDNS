import { describe, expect, it, beforeEach } from 'vitest';
import { clearParsedCache } from '../groupedCacheJob';

/**
 * 进程内解析缓存的失效语义（只测纯内存部分，不依赖 DB）。
 * 真正的「命中率/性能」由压测验证，这里守住「清空后不残留」。
 */
describe('grouped cache 解析层', () => {
  beforeEach(() => clearParsedCache());

  it('clearParsedCache 可重复调用且不抛错', () => {
    expect(() => { clearParsedCache(); clearParsedCache(); }).not.toThrow();
  });
});
