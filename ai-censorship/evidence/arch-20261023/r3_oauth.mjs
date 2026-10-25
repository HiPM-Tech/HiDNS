
import fs from 'node:fs';
const B = 'http://127.0.0.1:3911';
const raw = fs.readFileSync('/tmp/archtest3/pck', 'utf8');
const m = raw.match(/token\t(\S+)/);
const token = m ? m[1] : '';
if (!token) { console.log('cookie not found'); process.exit(1); }
const H = { 'Content-Type': 'application/json', Cookie: 'token=' + token };
const reg = await (await fetch(B + '/api/mcp/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_name: 'r3-probe', redirect_uris: ['http://127.0.0.1:9999/cb'] }) })).json();
console.log('register:', reg.client_id ? 'ok' : JSON.stringify(reg).slice(0, 200));
const client_id = reg.client_id, client_secret = reg.client_secret, redirect_uri = 'http://127.0.0.1:9999/cb';
const auth = await (await fetch(B + '/api/mcp/oauth/authorize', { method: 'POST', headers: H,
  body: JSON.stringify({ client_id, redirect_uri, decision: 'allow', scope: 'dns:read' }) })).json();
const code = auth.redirect_url ? new URL(auth.redirect_url).searchParams.get('code') : null;
console.log('issued code:', code ? code.slice(0, 10) + '...' : JSON.stringify(auth).slice(0, 200));
const body = { grant_type: 'authorization_code', code, client_id, client_secret, redirect_uri };
const one = async () => { const r = await fetch(B + '/api/mcp/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); return { status: r.status, token: j.access_token ? j.access_token.slice(0, 8) + '...' : null, err: j.error || null }; };
const [a, b] = await Promise.all([one(), one()]);
console.log('concurrent #1:', JSON.stringify(a));
console.log('concurrent #2:', JSON.stringify(b));
console.log('both got access_token =', !!(a.token && b.token));
console.log('third attempt:', JSON.stringify(await one()));
