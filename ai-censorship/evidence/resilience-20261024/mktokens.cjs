
const jwt = require('/workspace/HiDNS/server/node_modules/jsonwebtoken');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const db = new DatabaseSync('/tmp/res-audit/data/app.db');
const row = db.prepare("select value from runtime_secrets where key='jwt_runtime'").get();
if (!row) { console.log('NO RUNTIME SECRET'); process.exit(1); }
const secret = 'resilience-audit-secret-0123456789abcdef:' + row.value;
const ids = [3,5,6,7,8,9,10,11,12];
const tokens = ids.map(id => jwt.sign({ userId: id, username: 'u'+id, nickname: 'U'+id, role: 3 }, secret, { expiresIn: '7d' }));
fs.writeFileSync('/tmp/res-audit/tokens.json', JSON.stringify(tokens));
console.log('tokens', tokens.length);
