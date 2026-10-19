/**
 * WHOIS 到期事件的去重。
 *
 * 背景：WHOIS 同步是周期任务，`checkAndSendNotification` 每次同步都会调用。
 * 若不做去重，一个还剩 7 天的域名会在每次同步时都发布 `whois.expiring`。
 *
 * 去重键是**剩余天数**：`whois.expiring` 的 withinDays 过滤依赖 `daysLeft` 分级
 * （30/7/1 天各提醒一次），若改按到期时间去重，整周期只会发一次，分级永久失效。
 * 代价：上游 expiry 抖动导致天数 A→B→A 时会重复发布一次 —— 可接受，且比丢提醒安全。
 */

export class DaysLeftDedupe {
  private readonly last = new Map<number, string>();
  private readonly maxEntries: number;

  constructor(maxEntries = 5000) {
    this.maxEntries = maxEntries;
  }

  /** 返回 true 表示应当发布事件 */
  shouldEmit(domainId: number, daysLeft: number): boolean {
    if (!Number.isFinite(domainId) || !Number.isFinite(daysLeft)) return false;
    const key = String(daysLeft);

    const previous = this.last.get(domainId);
    if (previous === key) {
      // 命中时刷新位置（LRU），避免淘汰最稳定、最该保留的条目
      this.last.delete(domainId);
      this.last.set(domainId, key);
      return false;
    }

    this.last.set(domainId, key);
    if (this.last.size > this.maxEntries) {
      const excess = this.last.size - this.maxEntries;
      let removed = 0;
      for (const k of this.last.keys()) {
        if (removed >= excess) break;
        this.last.delete(k);
        removed += 1;
      }
    }
    return true;
  }

  /** 域名被删除或续期后重置，使下一次检查能重新发布 */
  reset(domainId: number): void {
    this.last.delete(domainId);
  }

  size(): number {
    return this.last.size;
  }
}

export const whoisEventDedupe = new DaysLeftDedupe();