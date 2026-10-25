
import { connect, disconnect, getConnection } from '/workspace/HiDNS/server/src/db/dal/connection';
import { initializeDSM } from '/workspace/HiDNS/server/src/db/dsm/init-dsm';
import { SchemaReconciler } from '/workspace/HiDNS/server/src/db/dsm/schema-reconciler';
import { COMPLETE_SCHEMA } from '/workspace/HiDNS/server/src/db/dsm/schemas/complete-schema';

await connect();
await initializeDSM();
const conn: any = getConnection();
await conn.execute("INSERT INTO users (username,nickname,email,password_hash,role,role_level) VALUES ('u','u','u@t.co','x','admin',3)");
await conn.execute("INSERT INTO dns_accounts (type,name,config,remark,enabled,created_by) VALUES ('virtual','a','{}','',1,1)");
await conn.execute("INSERT INTO domains (account_id,name,remark,record_count) VALUES (1,'keep.test','KEEP-ME-42',0)");
console.log('BEFORE :', JSON.stringify(await conn.query("SELECT name, remark FROM domains")));

const cloned: any = JSON.parse(JSON.stringify(COMPLETE_SCHEMA));
const t = cloned.tables.find((x: any) => x.name === 'domains');
const i = t.columns.findIndex((c: any) => c.name === 'remark');
t.columns[i] = { name: 'remark_note', type: 'text', nullable: true, defaultValue: '' };

const rec = new SchemaReconciler();
await rec.reconcile(cloned, { dryRun: false });

const cols = (await conn.query("PRAGMA table_info(domains)")).map((c: any) => c.name);
console.log('AFTER columns:', cols.join(','));
console.log('AFTER  :', JSON.stringify(await conn.query("SELECT name, remark_note FROM domains")));
console.log('OLD column still present =', cols.includes('remark'), '| 数据是否保住 =', (await conn.query("SELECT remark_note FROM domains"))[0].remark_note === 'KEEP-ME-42');
await disconnect();
process.exit(0);
