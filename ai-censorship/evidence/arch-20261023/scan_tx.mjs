
import fs from 'fs'; import path from 'path';
const root = process.argv[2];
const files = fs.readdirSync(path.join(root,'routes')).filter(f=>f.endsWith('.ts') && !f.includes('.test.'));
const re = /router\.(get|post|put|delete|patch)\(\s*'([^']*)'/g;
for (const f of files) {
  const text = fs.readFileSync(path.join(root,'routes',f),'utf8');
  const marks = [...text.matchAll(re)].map(m=>({idx:m.index, method:m[1], p:m[2]}));
  for (let i=0;i<marks.length;i++){
    const start = marks[i].idx, end = i+1<marks.length?marks[i+1].idx:text.length;
    const body = text.slice(start,end);
    const writes = [...body.matchAll(/([A-Za-z]+Operations)\.([a-zA-Z]+)\(/g)].map(m=>m[1]+'.'+m[2]);
    const mutating = writes.filter(w=>/(create|update|delete|remove|add|set|insert|upsert|save|rotate|revoke|bulk|replace)/i.test(w.split('.')[1]));
    if (mutating.length >= 2) {
      const line = text.slice(0,start).split('\n').length;
      console.log(`${f}:${line} ${marks[i].method.toUpperCase()} ${marks[i].p} :: ${mutating.join(', ')}`);
    }
  }
}
