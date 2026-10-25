
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/tmp/res-audit/data/app.db');
db.exec('PRAGMA busy_timeout = 100');
db.exec('BEGIN IMMEDIATE');
console.log('LOCK HELD', new Date().toISOString());
setTimeout(() => { try { db.exec('COMMIT'); } catch(e) { console.log('commit err', e.message); } console.log('LOCK RELEASED'); }, 15000);
