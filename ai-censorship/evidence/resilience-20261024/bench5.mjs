
import fs from 'node:fs';
const base='http://127.0.0.1:4391';
const login = async (u) => { const r = await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:'AuditPass123!'})}); if(!r.ok) throw new Error('login '+u+' '+r.status); return (r.headers.getSetCookie()||[]).map(c=>c.split(';')[0]).join('; '); };
const cookies = [];
for (const u of ['audit-user7','audit-user8','audit-user9']) cookies.push(await login(u));
const PID=99708; const rss=()=>{try{const m=fs.readFileSync('/proc/'+PID+'/status','utf8').match(/VmRSS:\s+(\d+) kB/);return +(Number(m[1])/1024).toFixed(1);}catch{return -1;}};
async function run(label, url, ms, conc){
  let n=0,err=0; const lat=[]; const deadline=Date.now()+ms; const r0=rss();
  await Promise.all(cookies.slice(0,conc).map(async ck=>{ while(Date.now()<deadline){ const t=Date.now(); try{ const r=await fetch(base+url,{headers:{Cookie:ck}}); const b=await r.json(); if(r.status!==200||b.code!==0) err++; }catch{err++;} lat.push(Date.now()-t); n++; } }));
  lat.sort((a,b)=>a-b);
  console.log(JSON.stringify({label, requests:n, qps:+(n/(ms/1000)).toFixed(1), p50:lat[Math.floor(lat.length*0.5)], p95:lat[Math.floor(lat.length*0.95)], max:lat[lat.length-1], errors:err, rssDeltaMB:+(rss()-r0).toFixed(1)}));
}
await run('super-grouped-conc1-15s', '/api/domains?grouped=true&page=1&pageSize=10', 15000, 1);
await run('super-grouped-conc3-30s', '/api/domains?grouped=true&page=1&pageSize=10', 30000, 3);
await run('super-nongrouped-conc3-15s', '/api/domains?page=1&pageSize=10', 15000, 3);
