/**
 * 运行记录保留策略。
 *
 * 背景：每次运行（含 skipped / concurrent-run）都会写一行 workflow_runs。
 * 事件频繁的工作流会让该表无界增长，最终拖慢查询与备份。
 *
 * 策略：每个工作流只保留最近 N 条；每写入 M 次触发一次清理，避免每次都做删除。
 */

export interface PrunePolicy {
  /** 每个工作流保留的最大条数 */
  keep: number;
  /** 每写入多少次触发一次清理 */
  every: number;
}

export const DEFAULT_PRUNE_POLICY: PrunePolicy = { keep: 500, every: 50 };

export class PruneScheduler {
  private readonly counters = new Map<number, number>();

  constructor(private readonly policy: PrunePolicy = DEFAULT_PRUNE_POLICY) {}

  /** 记录一次写入，返回是否应当执行清理 */
  onInsert(workflowId: number): boolean {
    if (!Number.isFinite(workflowId) || workflowId <= 0) return false;
    const next = (this.counters.get(workflowId) ?? 0) + 1;
    if (next >= this.policy.every) {
      this.counters.set(workflowId, 0);
      return true;
    }
    this.counters.set(workflowId, next);
    return false;
  }

  keep(): number {
    return this.policy.keep;
  }

  reset(): void {
    this.counters.clear();
  }
}

export const runPruneScheduler = new PruneScheduler();