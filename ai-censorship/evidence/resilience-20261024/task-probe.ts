
import { taskManager } from '/workspace/HiDNS/server/src/service/taskManager';

async function main() {
  // --- 1) 单任务声明的 concurrency 是否生效 ---
  let running = 0, maxRunning = 0;
  const t0 = Date.now();
  const jobs = Array.from({ length: 6 }, (_, i) =>
    taskManager.submit(
      { id: 'probe-conc-' + i, name: 'conc-' + i, concurrency: 1, timeout: 10000 },
      async () => {
        running++; maxRunning = Math.max(maxRunning, running);
        await new Promise(r => setTimeout(r, 300));
        running--;
      },
    )
  );
  await Promise.all(jobs);
  console.log(JSON.stringify({ test: 'concurrency-option', declaredPerTask: 1, observedMaxSimultaneous: maxRunning, elapsedMs: Date.now() - t0 }));

  // --- 2) 超时是否真正取消任务 / 重试是否与仍在运行的旧执行重叠 ---
  let executions = 0, finished = 0, overlap = 0;
  let current = 0, maxOverlap = 0;
  const ranAt: number[] = [];
  const t1 = Date.now();
  try {
    await taskManager.submit(
      { id: 'probe-timeout', name: 'timeout-retry', timeout: 300, retries: 1, retryDelay: 100 },
      async () => {
        executions++; current++; maxOverlap = Math.max(maxOverlap, current);
        ranAt.push(Date.now() - t1);
        await new Promise(r => setTimeout(r, 1200));   // 慢任务：远超 timeout
        finished++; current--;
      },
    );
  } catch (e: any) {
    console.log(JSON.stringify({ test: 'timeout', rejected: true, message: String(e.message).slice(0, 80), elapsedMs: Date.now() - t1 }));
  }
  await new Promise(r => setTimeout(r, 3000));
  console.log(JSON.stringify({ test: 'timeout-non-cancel', executions, completedBodyRuns: finished, maxOverlap, startsAt: ranAt, note: 'timeout 只拒绝 Promise，底层函数仍在跑；retries 再启动一遍 => 同一任务重叠执行' }));

  // --- 3) 同 ID 冲突的延后重排 + 上限 ---
  const t2 = Date.now();
  let idRuns = 0;
  const first = taskManager.submit({ id: 'probe-sameid', name: 'same-a', timeout: 5000 }, async () => {
    idRuns++; await new Promise(r => setTimeout(r, 1500));
  });
  await new Promise(r => setTimeout(r, 50));
  const second = taskManager.submit({ id: 'probe-sameid', name: 'same-b', timeout: 5000 }, async () => {
    idRuns++; await new Promise(r => setTimeout(r, 100));
  });
  const results = await Promise.allSettled([first, second]);
  console.log(JSON.stringify({ test: 'same-id', idRuns, statuses: results.map(r => r.status), elapsedMs: Date.now() - t2, stats: taskManager.getStats() }));
  process.exit(0);
}
main();
