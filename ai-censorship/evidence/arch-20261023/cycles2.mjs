
import fs from 'fs'; import path from 'path';
const root = '/workspace/HiDNS/server/src';
function walk(d, out=[]) { for (const e of fs.readdirSync(d,{withFileTypes:true})) { const p=path.join(d,e.name); if(e.isDirectory()) walk(p,out); else if(e.name.endsWith('.ts')) out.push(p);} return out; }
const files = walk(root); const set = new Set(files);
function resolve(from, spec) { if(!spec.startsWith('.')) return null; const base=path.resolve(path.dirname(from),spec);
  for (const c of [base+'.ts', path.join(base,'index.ts')]) if (set.has(c)) return c; return null; }
const edges = [];
for (const f of files) { const text=fs.readFileSync(f,'utf8');
  const re=/(?:from\s+['"]([^'"]+)['"])|(?:import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
  for (const m of text.matchAll(re)) { const r=resolve(f,m[1]||m[2]); if(r) edges.push([f,r]); } }
const g=new Map(); for (const [a,b] of edges){ if(!g.has(a))g.set(a,new Set()); g.get(a).add(b); }
let idx=0; const index=new Map(), low=new Map(), on=new Set(), st=[], sccs=[];
function strong(v){ index.set(v,idx); low.set(v,idx); idx++; st.push(v); on.add(v);
  for (const w of g.get(v)||[]) { if(!index.has(w)){strong(w); low.set(v,Math.min(low.get(v),low.get(w)));} else if(on.has(w)) low.set(v,Math.min(low.get(v),index.get(w))); }
  if(low.get(v)===index.get(v)){ const comp=[]; let w; do{w=st.pop(); on.delete(w); comp.push(w);}while(w!==v); if(comp.length>1) sccs.push(comp); } }
for (const v of g.keys()) if(!index.has(v)) strong(v);
for (const comp of sccs) {
  const s=new Set(comp);
  console.log('=== SCC size', comp.length);
  for (const [a,b] of edges) if (s.has(a)&&s.has(b)) console.log('   ', path.relative(root,a), '->', path.relative(root,b));
}
