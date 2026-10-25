
import wspkg from '/workspace/HiDNS/server/node_modules/ws/index.js';
const { WebSocket } = wspkg;
import fs from 'node:fs';
const url = 'ws://127.0.0.1:4391/api/socket/ws';
const N = Number(process.argv[2] || 300);
const pid = process.argv[3];
const rss = () => { try { const m = fs.readFileSync('/proc/'+pid+'/status','utf8').match(/VmRSS:\s+(\d+) kB/); return m ? (Number(m[1])/1024).toFixed(1)+'MB' : 'n/a'; } catch { return 'n/a'; } };
const logSize = () => { try { return (fs.statSync('/tmp/res-audit/server.log').size/1024/1024).toFixed(2)+'MB'; } catch { return 'n/a'; } };
const fds = () => { try { return fs.readdirSync('/proc/'+pid+'/fd').length; } catch { return -1; } };

console.log('before: rss='+rss()+' fds='+fds()+' log='+logSize());
const t0 = Date.now();
const socks = [];
let opened = 0, closed = 0, errored = 0;
for (let i=0;i<N;i++){
  const ws = new WebSocket(url);
  socks.push(ws);
  ws.on('open', () => opened++);
  ws.on('close', () => closed++);
  ws.on('error', () => errored++);
  if (i % 50 === 0) await new Promise(r=>setTimeout(r,20));
}
await new Promise(r=>setTimeout(r,3000));
const t = Date.now()-t0;
console.log(JSON.stringify({connections:N, opened, closed, errored, elapsedMs:t, rssAfter:rss(), fdsAfter:fds(), logAfter:logSize()}));
// 保持连接 5 秒，观察 fd/内存
await new Promise(r=>setTimeout(r,5000));
console.log(JSON.stringify({stillOpen: socks.filter(s=>s.readyState===1).length, rss:rss(), fds:fds(), log:logSize()}));
// 全部断开
for (const s of socks) { try { s.close(); } catch {} }
await new Promise(r=>setTimeout(r,2500));
console.log(JSON.stringify({afterClose: {rss:rss(), fds:fds(), log:logSize()}}));
process.exit(0);
