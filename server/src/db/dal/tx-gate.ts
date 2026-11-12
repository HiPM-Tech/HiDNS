import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 事务上下文与门闩。
 *
 * 背景：SQLite 驱动只有一个连接句柄，`BEGIN` 之后**所有**走该句柄的语句都落在同一个事务里。
 * 于是并发场景下：
 *   1) 别的请求的写入会被卷进当前事务，本事务回滚时会连带丢掉别人已经返回成功的写入；
 *   2) 第二个事务再 `BEGIN` 会直接报 `cannot start a transaction within a transaction`。
 *
 * 这里用 AsyncLocalStorage 标记「当前异步上下文是否在事务内」，并在驱动入口加门闩：
 *   - 事务内：放行（trx 自己就是这么执行的，不能等自己）；
 *   - 事务外：等待当前事务结束后再执行。
 *
 * MySQL/PostgreSQL 每个事务独占一条池连接，不存在这个问题，门闩只对 SQLite 生效。
 */
interface TxStore {
  depth: number;
}

const txStore = new AsyncLocalStorage<TxStore>();
let activeTx: Promise<void> | null = null;

export function inTransaction(): boolean {
  return txStore.getStore() !== undefined;
}

export function runInTxContext<T>(fn: () => Promise<T>): Promise<T> {
  return txStore.run({ depth: 1 }, fn);
}

async function waitForIdleTransaction(): Promise<void> {
  while (activeTx) {
    await activeTx;
  }
}

/**
 * 申请一个事务槽位：等到没有活跃事务后**同步**占位，再返回释放函数。
 *
 * 「等待」与「占位」之间不能有 await —— 否则两个并发调用会同时通过检查、
 * 各自 BEGIN，第二个直接报 `cannot start a transaction within a transaction`。
 */
export async function acquireTransactionSlot(): Promise<() => void> {
  while (activeTx) {
    await activeTx;
  }
  let release!: () => void;
  activeTx = new Promise<void>((resolve) => { release = resolve; });
  return () => {
    activeTx = null;
    release();
  };
}

/** 驱动入口调用：事务内放行；事务外排队等事务结束 */
export async function guardOutsideTransaction(): Promise<void> {
  if (inTransaction()) return;
  await waitForIdleTransaction();
}