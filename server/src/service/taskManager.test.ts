/**
 * TaskManager 同 ID 任务冲突回归测试。
 *
 * 修复前的行为：同 ID 任务已在运行时，executeTask 会把该任务同步 unshift 回队首，
 * 使 processQueue 的 while 反复取出同一任务并同步自旋，**彻底阻塞事件循环**。
 * 本测试通过「定时器能否回调」来判定事件循环是否可用——若被阻塞，
 * 200ms 的定时器永不触发，测试将一直挂到超时并失败。
 */
import { describe, expect, it } from 'vitest';
import { taskManager } from './taskManager';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timeout');
    await sleep(10);
  }
}

describe('TaskManager 同 ID 任务冲突', () => {
  it('冲突时不得阻塞事件循环（定时器必须能正常回调）', async () => {
    const taskId = `conflict-${Date.now()}`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let firstStarted = false;

    // 1) 提交一个挂起的任务，占住该 ID
    const first = taskManager.submit(
      { id: taskId, name: 'Blocking Task', timeout: 10000 },
      async () => {
        firstStarted = true;
        await gate;
      }
    );
    await waitUntil(() => firstStarted);

    // 2) 同 ID 再提交一次：修复前此处会让 processQueue 同步自旋
    const second = taskManager.submit(
      { id: taskId, name: 'Conflicting Task', timeout: 10000 },
      async () => { /* 无需做事 */ }
    );

    // 3) 事件循环仍可用：200ms 定时器必须能回调
    const timerFired = await new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(true), 200);
    });
    expect(timerFired).toBe(true);

    // 4) 释放阻塞任务，冲突任务应在延后重排后执行完毕
    release();
    await first;
    await second;

    expect(taskManager.getRunningCount()).toBe(0);
  }, 15000);

  it('冲突任务被延后重排，且队列不会无限增长', async () => {
    const taskId = `defer-${Date.now()}`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let firstStarted = false;
    let secondRan = false;

    const first = taskManager.submit(
      { id: taskId, name: 'Blocking Task', timeout: 10000 },
      async () => {
        firstStarted = true;
        await gate;
      }
    );
    await waitUntil(() => firstStarted);

    const second = taskManager.submit(
      { id: taskId, name: 'Deferred Task', timeout: 10000 },
      async () => { secondRan = true; }
    );

    // 延后期间队列长度保持有界（修复前是同步自旋，队列长度恒为 1 但事件循环被占死）
    await sleep(300);
    expect(taskManager.getQueuedCount()).toBeLessThanOrEqual(1);
    expect(secondRan).toBe(false); // 阻塞任务未结束前，冲突任务不应执行

    release();
    await first;
    await second;

    expect(secondRan).toBe(true);
  }, 15000);
});
