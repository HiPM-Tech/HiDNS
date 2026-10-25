
import { taskManager } from '/workspace/HiDNS/server/src/service/taskManager';
async function main(){
  const before = process.memoryUsage().rss/1048576;
  const N = 500;
  let done = 0;
  const t0 = Date.now();
  const subs = [];
  for (let i=0;i<N;i++){
    subs.push(taskManager.submit({ id: 'storm-'+i, name: 'storm-'+i, timeout: 60000 }, async () => {
      await new Promise(r=>setTimeout(r, 1000)); done++;
    }).catch(()=>{}));
  }
  await new Promise(r=>setTimeout(r, 200));
  console.log(JSON.stringify({ submitted:N, running: taskManager.getRunningCount(), queued: taskManager.getQueuedCount(), rssBeforeMB: +before.toFixed(1), rssAfterMB: +(process.memoryUsage().rss/1048576).toFixed(1) }));
  // 观察队列排空速率
  const t1 = Date.now();
  await new Promise(r=>setTimeout(r, 5000));
  console.log(JSON.stringify({ after5s: { done, queued: taskManager.getQueuedCount(), running: taskManager.getRunningCount() }, projectedDrainSeconds: Math.ceil((taskManager.getQueuedCount()/3)*1) }));
  // 一个 critical 任务需要等多久
  const t2 = Date.now();
  await taskManager.submit({ id:'urgent', name:'urgent-critical', priority:'critical', timeout: 60000 }, async()=>{});
  console.log(JSON.stringify({ criticalWaitMs: Date.now()-t2 }));
  taskManager.clearQueue();
  await Promise.all(subs);
  process.exit(0);
}
main();
