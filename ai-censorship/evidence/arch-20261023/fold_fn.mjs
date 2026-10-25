
import fs from 'node:fs'; import path from 'node:path';
const root = '/workspace/HiDNS/server/src/lib/dns/providers';
function walk(d, o=[]) { for (const e of fs.readdirSync(d,{withFileTypes:true})) { const p=path.join(d,e.name); e.isDirectory()?walk(p,o):(e.name.endsWith('.ts')&&o.push(p)); } return o; }
for (const f of walk(root)) {
  const L = fs.readFileSync(f,'utf8').split('\n');
  L.forEach((line, i) => {
    if (!/total:\s*0,\s*list:\s*\[\]/.test(line)) return;
    let s = i, fn = '?';
    for (let j = i; j >= 0; j--) { const m = L[j].match(/^\s{2}(async\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/); if (m) { s = j; fn = m[2]; break; } }
    const ctx = L.slice(s, i+1).join('\n');
    if (/this\.error\s*=/.test(ctx)) return;
    console.log(path.relative('/workspace/HiDNS', f) + ':' + (i+1) + '  fn=' + fn + '  prev=' + (L[i-1] || '').trim().slice(0, 70));
  });
}
