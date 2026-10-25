
import fs from 'node:fs';
const m = fs.readFileSync('/tmp/arch6/ck', 'utf8').match(/token\t(\S+)/);
const H = { 'Content-Type': 'application/json', Cookie: 'token=' + m[1] };
const B = 'http://127.0.0.1:3920';
const created = await (await fetch(B + '/api/mcp/oauth/clients', { method: 'POST', headers: H,
  body: JSON.stringify({ app_name: 'r6-client', redirect_uris: ['http://127.0.0.1:9999/cb'], scope: 'dns:read' }) })).json();
console.log('1 create client  :', JSON.stringify(created).slice(0, 220));
const cid = created?.data?.client_id || created?.client_id;
const sec = created?.data?.client_secret || created?.client_secret;
const ru = 'http://127.0.0.1:9999/cb';
const auth = await (await fetch(B + '/api/mcp/oauth/authorize', { method: 'POST', headers: H,
  body: JSON.stringify({ client_id: cid, redirect_uri: ru, decision: 'allow', scope: 'dns:read' }) })).json();
const code = auth.redirect_url ? new URL(auth.redirect_url).searchParams.get('code') : null;
console.log('2 authorize      :', code ? 'code=' + code.slice(0, 10) : JSON.stringify(auth).slice(0, 160));
const tokRes = await fetch(B + '/api/mcp/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: cid, client_secret: sec, redirect_uri: ru }) });
const tok = await tokRes.json();
console.log('3 token(首兑)    :', tok.access_token ? 'OK status=' + tokRes.status : JSON.stringify(tok).slice(0, 160));
const intro = await (await fetch(B + '/api/mcp/oauth/introspect', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: tok.access_token || 'x' }) })).json();
console.log('4 introspect     :', JSON.stringify(intro).slice(0, 140));
const reuse = await (await fetch(B + '/api/mcp/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: cid, client_secret: sec, redirect_uri: ru }) })).json();
console.log('5 code 重放      :', reuse.error || 'REPLAY ACCEPTED(!)');
const rev = await (await fetch(B + '/api/mcp/oauth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: tok.access_token || 'x' }) })).json();
console.log('6 revoke         :', JSON.stringify(rev).slice(0, 100));
const intro2 = await (await fetch(B + '/api/mcp/oauth/introspect', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: tok.access_token || 'x' }) })).json();
console.log('7 撤销后 introspect:', JSON.stringify(intro2).slice(0, 60));
const mcpCall = await fetch(B + '/api/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + (tok.access_token || 'x') },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
console.log('8 OAuth token 调 /api/mcp tools/list:', mcpCall.status, (await mcpCall.text()).slice(0, 120));
