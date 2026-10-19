/**
 * 带 TTL 的惰性缓存（纯逻辑，可注入时钟）。
 * 设计动机：引擎每个事件都要读取启用中的工作流定义，直连数据库会造成
 * 「每个事件一次查询」。缓存 + 写操作显式失效，把读放大收窄。
 */

export interface CachedLoader<T> {
  get(): Promise<T>;
  invalidate(): void;
  stats(): { hits: number; misses: number; loadedAt: number | null };
}

export interface CacheOptions {
  ttlMs: number;
  now?: () => number;
}

export function createCachedLoader<T>(
  loader: () => Promise<T>,
  options: CacheOptions,
): CachedLoader<T> {
  const now = options.now ?? Date.now;
  let value: T | undefined;
  let loadedAt: number | null = null;
  let inflight: Promise<T> | null = null;
  let hits = 0;
  let misses = 0;

  const expired = () => loadedAt === null || now() - loadedAt >= options.ttlMs;

  return {
    async get(): Promise<T> {
      if (!expired() && value !== undefined) {
        hits += 1;
        return value;
      }
      // 并发合并：同时到达的多个事件只触发一次加载
      if (inflight) return inflight;

      misses += 1;
      inflight = (async () => {
        try {
          const loaded = await loader();
          value = loaded;
          loadedAt = now();
          return loaded;
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },

    invalidate(): void {
      value = undefined;
      loadedAt = null;
    },

    stats() {
      return { hits, misses, loadedAt };
    },
  };
}