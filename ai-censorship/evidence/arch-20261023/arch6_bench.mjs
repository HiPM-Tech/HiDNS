
import fs from 'node:fs';
const m = fs.readFileSync('/tmp/arch6/ck', 'utf8').match(/token\t(\S+)/);
const cookie = 'token=' + m[1];
async function bench(label, url, conc = 20, ms = 8000) {
  let done = 0, err = 0, bytes = 0;
  const lat = [];
  const end = Date.now() + ms;
  const worker = async () => {
    while (Date.now() < end) {
      const t0 = process.hrtime.bigint();
      try {
        const r = await fetch(url, { headers: { Cookie: cookie } });
        const b = await r.text();
        bytes += b.length;
        if (r.status !== 200) err++; else done++;
        lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
      } catch { err++; }
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  lat.sort((a, b) => a - b);
  const qps = (done / (ms / 1000)).toFixed(1);
  console.log(label.padEnd(22), 'qps=' + qps.padStart(6), 'ok=' + done, 'err=' + err,
    'p50=' + (lat[Math.floor(lat.length * 0.5)] || 0).toFixed(0) + 'ms',
    'p95=' + (lat[Math.floor(lat.length * 0.95)] || 0).toFixed(0) + 'ms',
    'avgKB=' + (bytes / Math.max(done, 1) / 1024).toFixed(1));
  return Number(qps);
}
const B = 'http://127.0.0.1:3920';
await bench('warmup', B + '/api/domains', 4, 2000);
const plain = await bench('非分组 /api/domains', B + '/api/domains', 20, 8000);
const grouped = await bench('分组 ?grouped=true', B + '/api/domains?grouped=true', 20, 8000);
console.log('差距倍数 =', (plain / grouped).toFixed(2) + 'x');
