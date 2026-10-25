
import net from 'node:net';
import { isPrivateAddress, resolvePublicTarget } from '/workspace/HiDNS/server/src/service/serviceMonitor';
const P = 39461;
const server = net.createServer((s)=>{ s.end('internal-service'); });
await new Promise<void>((r)=>server.listen(P,'127.0.0.1',()=>r()));
console.log('listening on 127.0.0.1:' + P);
const target = '::ffff:7f00:1';
console.log('isPrivateAddress(target) =', isPrivateAddress(target), '| resolvePublicTarget =', JSON.stringify(await resolvePublicTarget(target)));
await new Promise<void>((resolve)=>{
  const c = net.connect(P, target, () => { console.log('net.connect(' + P + ', ' + target + ') => CONNECTED (equivalent to 127.0.0.1)'); c.destroy(); resolve(); });
  c.on('error', (e: any) => { console.log('connect error:', e.message); resolve(); });
});
server.close();
