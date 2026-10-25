
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/tmp/res-audit/data/app.db');
const base = 'http://127.0.0.1:4391';

async function login(u){
  const r = await fetch(base + '/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:u,password:'AuditPass123!'})});
  const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  const ck = raw.map(c=>c.split(';')[0]).join('; ');
  const j = await r.json();
  if (j.code !== 0) throw new Error('login fail '+JSON.stringify(j).slice(0,200));
  return ck;
}
function cacheState(){
  const g = db.prepare("select cache_value from system_cache where cache_key='grouped_cache_ver'").get();
  const rows = db.prepare('select user_id,version from grouped_domains_cache').all();
  return { global: g ? g.cache_value : null, rows: rows.map(r=>({u:r.user_id, v:r.version})) };
}
const A = await login('testuser');
const B = await login('audit-user2');
console.log('logged in A(testuser id=3) B(audit-user2 id=4)');

async function get(ck, who){
  const t = Date.now();
  const r = await fetch(base + '/api/domains?grouped=true&pageSize=5&page=1', {headers:{Cookie: ck}});
  const body = await r.json();
  const ms = Date.now() - t;
  const st = cacheState();
  const mine = st.rows.find(x=>x.u === (who==='A'?3:4));
  const hit = mine && String(mine.v) === String(st.global);
  console.log(`${who} grouped GET -> ${r.status} ${body.code} ${ms}ms | globalVer=${st.global} | myRowVer=${mine?mine.v:'-'} | hit=${hit}`);
  return {ms, hit, global: st.global};
}

// 1) 预热：A 两次
await get(A,'A'); await get(A,'A');
// 2) B 首次：应使 A 的缓存失效
await get(B,'B');
// 3) A 再次：理论命中，实测？
await get(A,'A');
await get(B,'B');
await get(A,'A');
await get(B,'B');
console.log('--- 交替 10 次 ---');
let bumps = 0; let prev = cacheState().global; let hits = 0; let n = 0;
for (let i=0;i<10;i++){
  const who = i%2===0 ? 'A':'B';
  const ck = who==='A'?A:B;
  const res = await get(ck, who);
  const now = cacheState().global;
  if (String(now) !== String(prev)) { bumps++; prev = now; }
  if (res.hit) hits++;
  n++;
}
console.log(JSON.stringify({requests:n, globalVersionBumps:bumps, cacheHits:hits, hitRate: hits/n}));
