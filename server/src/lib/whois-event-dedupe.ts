/**
 * WHOIS 到期事件的去重。
 *
 * 背景：WHOIS 同步是周期任务，`checkAndSendNotification` 每次同步都会调用。
 * 若不做去重，一个还剩 7 天的域名会在每次同步时都发布 `whois.expiring`，
 * 工作流随之反复执行——与 `ns.changed` 的重复告警是同一类问题。
 *
 * 规则：**剩余天数发生变化时才发布**。同一状态重复出现不再触发。
 */

export class DaysLeftDedupe {
  private readonly last = new Map<number, number>();
  private readonly maxEntries: number;

  constructor(maxEntries = 5000) {
    this.maxEntries = maxEntries;
  }

  /** 返回 true 表示应当发布事件 */
  shouldEmit(domainId: number, daysLeft: number): boolean {
    if (!Number.isFinite(domainId) || !Number.isFinite(daysLeft)) return false;
    const previous = this.last.get(domainId);
    if (previous === daysLeft) return false;
    this.last.set(domainId, daysLeft);

    // 惰性清理：域名删除后条目不会自动消失
    if (this.last.size > this.maxEntries) {
      const excess = this.last.size - this.maxEntries;
      let removed = 0;
      for (const key of this.last.keys()) {
        if (removed >= excess) break;
        this.last.delete(key);
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