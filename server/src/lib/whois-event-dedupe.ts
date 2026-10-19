/**
 * WHOIS 到期事件的去重。
 *
 * 背景：WHOIS 同步是周期任务，`checkAndSendNotification` 每次同步都会调用。
 * 若不做去重，一个还剩 7 天的域名会在每次同步时都发布 `whois.expiring`。
 *
 * 去重键是**到期时间**而不是剩余天数：上游偶发返回不同 expiry 时天数会 A→B→A 抖动，
 * 按天数去重会每次发布；到期日不变就绝不重复。
 */

export class DaysLeftDedupe {
  private readonly last = new Map<number, string>();
  private readonly maxEntries: number;

  constructor(maxEntries = 5000) {
    this.maxEntries = maxEntries;
  }

  /** 返回 true 表示应当发布事件 */
  shouldEmit(domainId: number, expiresAt: string | number): boolean {
    if (!Number.isFinite(domainId)) return false;
    const key = String(expiresAt);
    if (!key || key === 'NaN' || key === 'undefined') return false;

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