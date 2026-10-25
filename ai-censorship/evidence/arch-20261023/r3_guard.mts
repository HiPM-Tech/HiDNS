
import net from 'node:net';
import { isPrivateAddress, resolvePublicTarget } from '/workspace/HiDNS/server/src/service/serviceMonitor';
const cases = ['127.0.0.1','10.0.0.1','169.254.169.254','::1','fe80::1','fc00::1','::ffff:127.0.0.1','::ffff:7f00:1','::ffff:a9fe:a9fe','100.64.0.1','198.18.0.1','192.0.0.1','8.8.8.8'];
console.log('--- isPrivateAddress (内网应为 true)');
for (const c of cases) console.log(c.padEnd(20), 'isIP=' + net.isIP(c), 'private=' + isPrivateAddress(c));
console.log('--- resolvePublicTarget(IP 字面量)');
for (const c of ['::ffff:7f00:1','::ffff:a9fe:a9fe','127.0.0.1']) {
  console.log(c.padEnd(20), JSON.stringify(await resolvePublicTarget(c)));
}
console.log('--- resolvePublicTarget(重定向按整条 URL 传入)');
for (const u of ['http://example.com/','https://example.com:8443/a?b=1']) {
  console.log(u.padEnd(28), JSON.stringify(await resolvePublicTarget(u)));
}
