/**
 * Task Manager - 后台任务管理器
 * 实现任务队列、并发控制和执行调度，避免多个任务同时执行导致系统卡顿
 */

import { createLogger } from '../lib/logger';

const log = createLogger('Job').sub('TaskManager');
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

export interface TaskInfo {
  id: string;
  name: string;
  status: TaskStatus;
  priority?: TaskPriority;
  startTime?: number;
  endTime?: number;
  duration?: number;
  error?: Error;
}

export interface TaskOptions {
  /** 任务唯一标识 */
  id: string;
  /** 任务名称 */
  name: string;
  /** 任务优先级（默认 normal） */
  priority?: TaskPriority;
  /** 最大并发数（默认1，即串行执行） */
  concurrency?: number;
  /** 超时时间（毫秒）。0 或未设置时使用兜底超时，不允许无界运行 */
  timeout?: number;
  /** 失败后重试次数 */
  retries?: number;
  /** 重试间隔（毫秒） */
  retryDelay?: number;
}

interface QueuedTask {
  options: TaskOptions;
  fn: () => Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  attempts: number;
  queuedAt: number; // 入队时间，用于排序
  deferrals: number; // 因同 ID 任务仍在运行而被延后重排的次数
}

/** 同 ID 任务冲突时的基础延后时长（毫秒），按次数指数退避 */
const REQUEUE_BASE_DELAY_MS = 1000;
/** 同 ID 任务冲突的最大延后次数，超过则判定为异常并失败，避免无限等待 */
const MAX_REQUEUE_DEFERRALS = 60;
/** 未显式配置超时的任务所使用的兜底超时（毫秒），确保任务必然结束、ID 必然释放 */
/** 超时后等待任务体自行结束的宽限；超过则强制释放 ID（防止队列停摆） */
const HARD_TIMEOUT_GRACE_MS = 5 * 60_000;

const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;

export class TaskManager {
  private runningTasks: Map<string, TaskInfo> = new Map();
  private taskQueue: QueuedTask[] = [];
  private maxConcurrentTasks: number = 3; // 全局最大并发任务数
  private isProcessing: boolean = false;

  /**
   * 设置全局最大并发任务数
   */
  setMaxConcurrentTasks(max: number): void {
    this.maxConcurrentTasks = max;
    log.info(`Max concurrent tasks set to ${max}`);
    this.processQueue();
  }

  /**
   * 获取当前运行中的任务数
   */
  getRunningCount(): number {
    return this.runningTasks.size;
  }

  /**
   * 获取队列中等待的任务数
   */
  getQueuedCount(): number {
    return this.taskQueue.length;
  }

  /**
   * 获取所有任务信息
   */
  getAllTasks(): TaskInfo[] {
    return Array.from(this.runningTasks.values());
  }

  /**
   * 提交任务到队列
   */
  async submit(options: TaskOptions, fn: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const queuedTask: QueuedTask = {
        options,
        fn,
        resolve,
        reject,
        attempts: 0,
        queuedAt: Date.now(),
        deferrals: 0,
      };

      // 根据优先级插入队列（高优先级插队）
      this.insertTaskByPriority(queuedTask);

      log.debug(`Task queued: ${options.name} (${options.id})`, {
        queueLength: this.taskQueue.length,
        priority: options.priority || 'normal',
      });

      this.processQueue();
    });
  }

  /**
   * 根据优先级插入任务到队列
   * 优先级顺序：critical > high > normal > low
   */
  private insertTaskByPriority(task: QueuedTask): void {
    const priorityValue = this.getPriorityValue(task.options.priority || 'normal');

    // 找到第一个优先级低于当前任务的位置
    let insertIndex = this.taskQueue.length;
    for (let i = 0; i < this.taskQueue.length; i++) {
      const existingPriority = this.getPriorityValue(this.taskQueue[i].options.priority || 'normal');
      if (priorityValue > existingPriority) {
        insertIndex = i;
        break;
      }
    }

    // 插入到合适的位置
    this.taskQueue.splice(insertIndex, 0, task);

    if (insertIndex < this.taskQueue.length - 1) {
      log.info(`High priority task inserted at position ${insertIndex}: ${task.options.name}`, {
        priority: task.options.priority,
      });
    }
  }

  /**
   * 获取优先级的数值表示（越大优先级越高）
   */
  private getPriorityValue(priority: TaskPriority): number {
    switch (priority) {
      case 'critical': return 4;
      case 'high': return 3;
      case 'normal': return 2;
      case 'low': return 1;
      default: return 2;
    }
  }

  /**
   * 处理任务队列
   *
   * 注意：同 ID 任务仍在运行时**不得**在循环内把它塞回队首——那会让 while 反复取出
   * 同一个任务并同步自旋，彻底阻塞事件循环（曾导致 ~3.2k 行/秒的日志洪水与全站无响应）。
   * 此类冲突一律改为异步延后重排。
   */
  private processQueue(): void {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.taskQueue.length > 0 && this.runningTasks.size < this.maxConcurrentTasks) {
        const queuedTask = this.taskQueue.shift();
        if (!queuedTask) break;

        if (this.runningTasks.has(queuedTask.options.id)) {
          this.deferTask(queuedTask);
          continue;
        }

        this.executeTask(queuedTask);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * 同 ID 任务冲突时延后重排。
   * 全程使用 setTimeout（异步），不阻塞事件循环；带指数退避、次数上限与日志限流。
   */
  private deferTask(queuedTask: QueuedTask): void {
    queuedTask.deferrals += 1;

    if (queuedTask.deferrals > MAX_REQUEUE_DEFERRALS) {
      log.error(`Task abandoned, same-id task still running: ${queuedTask.options.name}`, {
        taskId: queuedTask.options.id,
        deferrals: queuedTask.deferrals,
      });
      queuedTask.reject(new Error(
        `Task abandoned after ${MAX_REQUEUE_DEFERRALS} deferrals, previous run of "${queuedTask.options.id}" never finished`
      ));
      return;
    }

    const delay = Math.min(
      REQUEUE_BASE_DELAY_MS * Math.pow(2, Math.min(queuedTask.deferrals - 1, 6)),
      60000
    );

    // 日志限流：仅首次与每 10 次记录，避免同类日志洪水
    if (queuedTask.deferrals === 1 || queuedTask.deferrals % 10 === 0) {
      log.warn(`Task already running, deferred re-queue: ${queuedTask.options.name}`, {
        taskId: queuedTask.options.id,
        deferrals: queuedTask.deferrals,
        delayMs: delay,
      });
    }

    const timer = setTimeout(() => {
      this.insertTaskByPriority(queuedTask);
      this.processQueue();
    }, delay);
    // 不因该定时器阻止进程退出
    if (typeof timer.unref === 'function') timer.unref();
  }

  /**
   * 执行单个任务
   */
  private async executeTask(queuedTask: QueuedTask): Promise<void> {
    const { options, fn, resolve, reject, attempts } = queuedTask;
    const taskId = options.id;

    // 检查是否已有相同ID的任务在运行（防御性兜底：绝不在此同步塞回队列）
    if (this.runningTasks.has(taskId)) {
      this.deferTask(queuedTask);
      return;
    }

    // 创建任务信息
    const taskInfo: TaskInfo = {
      id: taskId,
      name: options.name,
      status: 'running',
      startTime: Date.now(),
    };

    this.runningTasks.set(taskId, taskInfo);
    log.info(`Task started: ${options.name}`, {
      taskId,
      runningCount: this.runningTasks.size,
      queuedCount: this.taskQueue.length,
    });

    let timedOut = false;
    let released = false;
    let hardTimer: NodeJS.Timeout | null = null;
    const release = (): void => {
      if (released) return;
      released = true;
      if (hardTimer) clearTimeout(hardTimer);
      this.runningTasks.delete(taskId);
      this.processQueue();
    };
    try {
      // 兜底超时：即便调用方未配置超时，也必须保证任务最终结束，
      // 否则任务 ID 永不释放，后续同 ID 提交将永久无法执行。
      let timeoutId: NodeJS.Timeout | null = null;
      const timeout = options.timeout && options.timeout > 0
        ? options.timeout
        : DEFAULT_TASK_TIMEOUT_MS;

      const fnPromise = fn().finally(() => {
        // 超时后 fn 仍可能在跑：只有它真正结束才释放 ID，避免同 ID 双跑
        if (timedOut) release();
      });
      const executionPromise = Promise.race([
        fnPromise,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            // 活性兜底：任务体若永不 settle，防止 ID 永久占用导致队列停摆
            hardTimer = setTimeout(() => {
              log.error('Task hard timeout: releasing task id after grace period', { taskId, graceMs: HARD_TIMEOUT_GRACE_MS });
              release();
            }, HARD_TIMEOUT_GRACE_MS);
            reject(new Error(`Task timeout after ${timeout}ms`));
          }, timeout);
        }),
      ]);

      await executionPromise;

      if (timeoutId) clearTimeout(timeoutId);

      // 任务成功
      taskInfo.status = 'completed';
      taskInfo.endTime = Date.now();
      taskInfo.duration = taskInfo.endTime - taskInfo.startTime!;

      log.info(`Task completed: ${options.name}`, {
        taskId,
        duration: taskInfo.duration,
      });

      resolve();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      // 重试逻辑
      const maxRetries = options.retries || 0;
      if (attempts < maxRetries) {
        const retryDelay = options.retryDelay || 1000;
        log.warn(`Task failed, retrying (${attempts + 1}/${maxRetries}): ${options.name}`, {
          taskId,
          error: err.message,
          retryDelay,
        });

        // 延迟后重新加入队列
        setTimeout(() => {
          this.taskQueue.unshift({
            ...queuedTask,
            attempts: attempts + 1,
          });
          this.processQueue();
        }, retryDelay);
      } else {
        // 达到最大重试次数，任务失败
        taskInfo.status = 'failed';
        taskInfo.endTime = Date.now();
        taskInfo.duration = taskInfo.endTime - taskInfo.startTime!;
        taskInfo.error = err;

        log.error(`Task failed: ${options.name}`, {
          taskId,
          attempts: attempts + 1,
          error: err.message,
        });

        reject(err);
      }
    } finally {
      // 超时路径：任务本体可能仍在运行，交给 fnPromise.finally 释放 ID
      if (!timedOut) release();
    }
  }

  /**
   * 取消任务
   */
  cancelTask(taskId: string): boolean {
    // 从队列中移除
    const index = this.taskQueue.findIndex(t => t.options.id === taskId);
    if (index !== -1) {
      const removed = this.taskQueue.splice(index, 1)[0];
      removed.reject(new Error('Task cancelled'));
      log.info(`Task cancelled from queue: ${removed.options.name}`, { taskId });
      return true;
    }

    // 无法取消正在运行的任务，只能标记
    if (this.runningTasks.has(taskId)) {
      log.warn(`Cannot cancel running task, it will complete: ${taskId}`);
      return false;
    }

    return false;
  }

  getStats(): { running: number; queued: number; completed: number; failed: number } {
    let completed = 0, failed = 0
    for (const task of this.runningTasks.values()) {
      if (task.status === 'completed') completed++
      if (task.status === 'failed') failed++
    }
    return { running: this.runningTasks.size, queued: this.taskQueue.length, completed, failed }
  }

  /**
   * 清空队列
   */
  clearQueue(): void {
    const count = this.taskQueue.length;
    this.taskQueue.forEach(task => {
      task.reject(new Error('Queue cleared'));
    });
    this.taskQueue = [];
    log.info(`Queue cleared, removed ${count} tasks`);
  }

  /**
   * 等待所有任务完成
   */
  async waitForAll(): Promise<void> {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.runningTasks.size === 0 && this.taskQueue.length === 0) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });
  }
}

// 导出单例
export const taskManager = new TaskManager();
