
import fs from 'node:fs';
import wspkg from '/workspace/HiDNS/server/node_modules/ws/index.js';
const { WebSocket } = wspkg;
const token = fs.readFileSync('/tmp/res-audit/token.txt','utf8').trim();
const url = 'ws://127.0.0.1:4391/api/socket/ws?token=' + encodeURIComponent(token);
const t0 = Date.now();
const log = (...a) => console.log(((Date.now()-t0)/1000).toFixed(1)+'s', ...a);

function connect(tag) {
  const ws = new WebSocket(url);
  const rec = { tag, ws, msgs: [] };
  ws.on('open', () => log(tag, 'open'));
  ws.on('message', (d) => { rec.msgs.push(String(d).slice(0,120)); log(tag, 'msg:', String(d).slice(0,100)); });
  ws.on('close', (code, reason) => log(tag, 'close', code, String(reason)));
  ws.on('error', (e) => log(tag, 'error', e.message));
  return rec;
}

// 阶段1：单连接基线（对照）
const a = connect('A-baseline');
await new Promise(r => setTimeout(r, 1200));
a.ws.send(JSON.stringify({ type: 'ping' }));
await new Promise(r => setTimeout(r, 1000));
log('--- baseline pong count for A:', a.msgs.filter(m => m.includes('pong')).length);

// 阶段2：同一用户第二次连接
const b = connect('B-second');
await new Promise(r => setTimeout(r, 1500));
for (let i = 0; i < 3; i++) {
  b.ws.send(JSON.stringify({ type: 'ping' }));
  await new Promise(r => setTimeout(r, 400));
}
await new Promise(r => setTimeout(r, 2000));
const pongB = b.msgs.filter(m => m.includes('"pong"')).length;
const connB = b.msgs.filter(m => m.includes('connected')).length;
log('B welcome(connected) msgs:', connB, ' B pong msgs:', pongB);
// 第三次连接，验证是否同样被孤立
const c = connect('C-third');
await new Promise(r => setTimeout(r, 1200));
c.ws.send(JSON.stringify({ type: 'ping' }));
await new Promise(r => setTimeout(r, 1500));
log('C pong msgs:', c.msgs.filter(m => m.includes('"pong"')).length);
// 资源快照广播（每 10s，仅当 server 端 clients.size>0）是否到达 B/C
await new Promise(r => setTimeout(r, 12000));
log('B resource snapshots:', b.msgs.filter(m=>m.includes('resource:snapshot')).length);
log('C resource snapshots:', c.msgs.filter(m=>m.includes('resource:snapshot')).length);
for (const x of [b,c]) { try { x.ws.close(); } catch {} }
await new Promise(r => setTimeout(r, 500));
process.exit(0);
