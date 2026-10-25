
import fs from 'fs'; import path from 'path';
const root = process.argv[2];
function walk(dir, out=[]) { for (const e of fs.readdirSync(dir,{withFileTypes:true})) { const p=path.join(dir,e.name);
  if (e.isDirectory()) { if(['node_modules','__tests__','lib'].includes(e.name)) continue; walk(p,out); }
  else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) out.push(p); } return out; }
function matchObj(text,start){ let i=text.indexOf('{',start); if(i<0) return null; let d=0;
  for(let j=i;j<text.length;j++){const c=text[j]; if(c==='{')d++; else if(c==='}'){d--; if(d===0) return text.slice(i,j+1);}} return null; }
const re=/res\s*\.\s*(?:status\s*\(\s*[^)]*\)\s*\.)?\s*(json)\s*\(/g;
let envNoData=0, nonEnv=0; const rows=[];
for (const file of walk(root)) { const text=fs.readFileSync(file,'utf8');
  for (const m of text.matchAll(re)) { const obj=matchObj(text,m.index); if(!obj) continue;
    const hasCode=/(?:^|[\s{,])code\s*:/.test(obj), hasData=/(?:^|[\s{,])data\s*[:,}]/.test(obj);
    if (hasCode && !hasData) { envNoData++; rows.push(path.relative(root,file)+':'+text.slice(0,m.index).split('\n').length); }
    else if (!hasCode) nonEnv++;
  } }
console.log('带 code 但缺 data 的信封站点:', envNoData);
console.log('完全非信封（无 code）:', nonEnv);
const byFile={}; for(const r of rows){const f=r.split(':')[0]; byFile[f]=(byFile[f]||0)+1;}
console.log(Object.entries(byFile).sort((a,b)=>b[1]-a[1]).map(([f,n])=>f+'='+n).join('  '));
