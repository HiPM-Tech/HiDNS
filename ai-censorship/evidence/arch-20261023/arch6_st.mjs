
import fs from 'node:fs';
const m = fs.readFileSync('/tmp/arch6/ck', 'utf8').match(/token\t(\S+)/);
const H = { 'Content-Type': 'application/json', Cookie: 'token=' + m[1] };
const B = 'http://127.0.0.1:3920';
const tokRes = await (await fetch(B + '/api/tokens', { method: 'POST', headers: H,
  body: JSON.stringify({ name: 'r6-token', description: 'r6', allowed_domains: [1] }) })).json();
const token = tokRes?.data?.token || tokRes?.data?.value || tokRes?.token || tokRes?.data?.plain_token;
console.log('create token:', token ? token.slice(0, 20) + '...' : JSON.stringify(tokRes).slice(0, 200));
if (!token) process.exit(0);
const cmp = async (label, url) => {
  const s1 = await (await fetch(B + url, { headers: { Cookie: H.Cookie } })).json();
  const s2 = await (await fetch(B + url, { headers: { Authorization: 'Bearer ' + token } })).json();
  const shape = (j) => Array.isArray(j?.data) ? 'array' : (j?.data && typeof j.data === 'object' ? 'object{' + Object.keys(j.data).join(',') + '}' : typeof j?.data);
  console.log(label.padEnd(30), 'session=' + shape(s1), '| token=' + shape(s2), '| sameShape=' + (shape(s1) === shape(s2)));
};
await cmp('GET /api/domains?grouped=true', '/api/domains?grouped=true');
await cmp('GET /api/domains', '/api/domains');
await cmp('GET /api/domains?format=array', '/api/domains?format=array');
await cmp('GET /api/accounts?page=1', '/api/accounts?page=1');
