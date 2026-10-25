
import { taskManager } from '/workspace/HiDNS/server/src/service/taskManager';
async function main(){
  await taskManager.submit({ id: 's1', name: 's1', timeout: 5000 }, async () => { await new Promise(r=>setTimeout(r,50)); });
  await new Promise(r=>setTimeout(r,100));
  console.log('AFTER_SUCCESS ' + JSON.stringify(taskManager.getStats()));
  try { await taskManager.submit({ id: 's2', name: 's2', timeout: 5000 }, async () => { throw new Error('boom'); }); } catch {}
  await new Promise(r=>setTimeout(r,100));
  console.log('AFTER_FAILURE ' + JSON.stringify(taskManager.getStats()));
  process.exit(0);
}
main();
