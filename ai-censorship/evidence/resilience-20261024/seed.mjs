
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/tmp/res-audit/data/app.db');
const N = Number(process.argv[2] || 5000);
const H = process.argv[3];
const ins = db.prepare("insert into domains (account_id,name,third_id,remark,is_hidden,enabled,record_count) values (2,?,?,?,0,1,3)");
db.exec('BEGIN');
for (let i=0;i<N;i++) ins.run('seed-'+i+'.example.com', 'third-'+i, 'seed '+i);
db.exec('COMMIT');
console.log('domains total', db.prepare('select count(*) c from domains').get().c);
for (let u=5; u<13; u++) {
  try { db.prepare("insert into users (id,username,nickname,email,password_hash,role,role_level,status) values (?,?,?,?,?,'admin',1,1)").run(u,'audit-user'+u,'U'+u,'u'+u+'@example.com',H); } catch(e) { db.prepare('update users set password_hash=? where id=?').run(H,u); }
}
console.log('users', db.prepare('select count(*) c from users').get().c);
