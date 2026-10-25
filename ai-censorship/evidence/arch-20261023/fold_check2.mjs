
import fs from 'node:fs';
import path from 'node:path';
const root = '/workspace/HiDNS/server/src/lib/dns/providers';
function walk(d, out=[]) { for (const e of fs.readdirSync(d,{withFileTypes:true})) { const p=path.join(d,e.name); if(e.isDirectory()) walk(p,out); else if(e.name.endsWith('.ts')) out.push(p);} return out; }
let wide = [];
for (const f of walk(root)) {
  const lines = fs.readFileSync(f,'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!/total:\s*0,\s*list:\s*\[\]/.test(line)) return;
    // 找最近的函数起点（async xxx( 或 xxx( 带 { ）
    let start = i;
    for (let j = i; j >= 0; j--) { if (/^\s{2}(async\s+)?[a-zA-Z_]+\s*\(/.test(lines[j])) { start = j; break; } }
    const ctx = lines.slice(start, i+1).join('\n');
    if (!/this\.error\s*=/.test(ctx)) wide.push(path.relative('/workspace/HiDNS',f)+':'+(i+1));
  });
}
console.log('函数内无 this.error 的折叠点（宽窗）:', wide.length, '/ 92');
console.log(wide.slice(0,8).join('  '));
