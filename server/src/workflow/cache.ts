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
  // 失效代数：加载期间若发生过 invalidate，则这份结果既不入缓存也不返回给调用方
  let generation = 0;

  const expired = () => loadedAt === null || now() - loadedAt >= options.ttlMs;

  async function load(): Promise<T> {
    // 并发合并：同时到达的多个事件只触发一次加载
    if (inflight) return inflight;

    const startedAt = generation;
    misses += 1;
    const promise = (async () => {
      try {
        return await loader();
      } finally {
        inflight = null;
      }
    })();
    inflight = promise;

    const loaded = await promise;
    if (startedAt !== generation) {
      // 失效期间完成：**不入缓存**，但已排队的调用方仍拿到这次的结果（不为一次写操作重排延迟）。
      // 下一次 get() 会重新加载，因此陈旧值最多存活到当前这批调用方结束。
      return loaded;
    }
    value = loaded;
    loadedAt = now();
    return loaded;
  }

  return {
    async get(): Promise<T> {
      if (!expired() && value !== undefined) {
        hits += 1;
        return value;
      }
      return load();
    },

    invalidate(): void {
      value = undefined;
      loadedAt = null;
      generation += 1;
    },

    stats() {
      return { hits, misses, loadedAt };
    },
  };
}