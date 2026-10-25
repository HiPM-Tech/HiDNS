
import express from '/workspace/HiDNS/server/node_modules/express/index.js';
import { rdapLimiter } from '/workspace/HiDNS/server/src/middleware/rateLimit';
const app = express();
app.use('/api/rdap', rdapLimiter, (req: any, res: any) => { res.json({ ok: 1 }); });
const srv = app.listen(39555, async () => {
  const out: string[] = [];
  for (let i = 0; i < 6; i++) {
    const r = await fetch('http://127.0.0.1:39555/api/rdap/x');
    const t = await r.text();
    out.push(r.status + ' [' + (r.headers.get('content-type') || '-') + '] ' + t.slice(0, 50));
  }
  console.log(out.join(' || '));
  srv.close();
});
