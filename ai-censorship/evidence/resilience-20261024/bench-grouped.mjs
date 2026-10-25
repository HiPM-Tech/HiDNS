
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
const db = new DatabaseSync('/tmp/res-audit/data/app.db');
const base = 'http://127.0.0.1:4391';
const pidArg = process.argv[2] || '';

function rssMB(){
  try {
    const s = fs.readFileSync('/proc/'+pidArg+'/status','utf8');
    const m = s.match(/VmRSS:\s+(\d+) kB/);
    return m ? (Number(m[1])/1024).toFixed(1) : 'n/a';
  } catch { return 'n/a'; }
}
function ver(){ const g = db.prepare("select cache_value from system_cache where cache_key='grouped_cache_ver'").get(); return g ? g.cache_value : null; }

async function login(u){
  const r = await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:'AuditPass123!'})});
  const j = await r.json();
  if (j.code !== 0) throw new Error('login '+u+' '+JSON.stringify(j).slice(0,150));
  return (r.headers.getSetCookie()||[]).map(c=>c.split(';')[0]).join('; ');
}
const pct = (arr,p)=>{ const s=[...arr].sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.floor(p/100*s.length))]; };

async function bench(label, cookies, total, conc, url){
  const lat=[]; const errs=[]; let i=0;
  const v0 = ver(); const rss0 = rssMB();
  async function worker(ck){
    while (true){
      const idx = i++; if (idx >= total) return;
      const t=Date.now();
      try{
        const r = await fetch(base+url,{headers:{Cookie:ck}});
        const b = await r.json().catch(()=>({}));
        if (r.status !== 200 || b.code !== 0) errs.push(r.status+':'+(b.msg||''));
        lat.push(Date.now()-t);
      }catch(e){ errs.push(String(e).slice(0,60)); lat.push(Date.now()-t); }
    }
  }
  await Promise.all(Array.from({length:conc},()=>worker(cookies[Math.floor(Math.random()*cookies.length)])));
  const v1 = ver();
  console.log(JSON.stringify({label, requests: lat.length, conc, p50: pct(lat,50), p95: pct(lat,95), max: Math.max(...lat), errors: errs.length, errSample: errs.slice(0,2), versionBefore: v0, versionAfter: v1, rssBefore: rss0, rssAfter: rssMB()}));
}

const A = await login('testuser');
const multi = [A];
for (let u=5; u<13; u++) multi.push(await login('audit-user'+u));
console.log('logins ok: ', multi.length);

await bench('warmup-single', [A], 5, 1, '/api/domains?grouped=true&page=1&pageSize=10');
await bench('grouped-single-user-20', [A], 20, 1, '/api/domains?grouped=true&page=1&pageSize=10');
await bench('grouped-9-users-90-conc10', multi, 90, 10, '/api/domains?grouped=true&page=1&pageSize=10');
await bench('nongrouped-9-users-90-conc10', multi, 90, 10, '/api/domains?page=1&pageSize=50');
await bench('grouped-9-users-270-conc20', multi, 270, 20, '/api/domains?grouped=true&page=1&pageSize=10');
