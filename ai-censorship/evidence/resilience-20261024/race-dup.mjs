
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/tmp/res-audit/data/app.db');
const base='http://127.0.0.1:4391';
const ck=(await (await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'testuser',password:'AuditPass123!'})})).headers.getSetCookie()||[]).map(c=>c.split(';')[0]).join('; ');
const name = 'race-dup-' + Date.now() + '.example.com';
const N = 20;
const reqs = Array.from({length:N}, (_,i)=> fetch(base+'/api/domains',{method:'POST',headers:{'Content-Type':'application/json',Cookie:ck},body:JSON.stringify({account_id:2,name,remark:'race '+i})}).then(async r=>({status:r.status, body: await r.json()})));
const res = await Promise.all(reqs);
const codes = {}; for (const r of res) { const k = r.status+':'+(r.body.code); codes[k]=(codes[k]||0)+1; }
const rows = db.prepare('select id, name, remark from domains where name = ?').all(name);
console.log(JSON.stringify({name, requests:N, responseCodes:codes, rowsInDb:rows.length, rows: rows.slice(0,5)}));
