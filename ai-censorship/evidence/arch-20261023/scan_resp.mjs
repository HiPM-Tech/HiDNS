
import fs from 'fs';
import path from 'path';

const root = process.argv[2];
function walk(dir, out=[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === 'node_modules' || e.name === '__tests__') continue; walk(p, out); }
    else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) out.push(p);
  }
  return out;
}

function matchObj(text, start) {
  // start at '(' position; find first '{' then brace-match
  let i = text.indexOf('{', start);
  if (i < 0) return null;
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(i, j+1); }
  }
  return null;
}

const re = /res\s*\.\s*(?:status\s*\(\s*([0-9]+)\s*\)\s*\.)?\s*(json|send|end|sendStatus|download|sendFile|render|jsonp|sendFileAsync|write)\s*\(/g;
const rows = [];
for (const file of walk(root)) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (const m of text.matchAll(re)) {
    const status = m[1] ? Number(m[1]) : null;
    const method = m[2];
    const lineNo = text.slice(0, m.index).split('\n').length;
    const line = (lines[lineNo-1]||'').trim();
    if (method === 'json' || method === 'jsonp' || method === 'send') {
      const obj = matchObj(text, m.index);
      let codeExpr = null;
      if (obj) {
        const cm = obj.match(/(?:^|[\s{,])code\s*:\s*([^,\n}]+)/);
        if (cm) codeExpr = cm[1].trim();
      }
      rows.push({file: path.relative(root, file), line: lineNo, status, method, codeExpr, hasObj: !!obj, snippet: line.slice(0,120)});
    } else {
      rows.push({file: path.relative(root, file), line: lineNo, status, method, codeExpr: 'N/A', hasObj: false, snippet: line.slice(0,120)});
    }
  }
}
const missing = rows.filter(r => r.method !== 'end' && r.status !== null && r.status >= 200 && r.status < 300 && r.status !== 200);
console.log("TOTAL response sites:", rows.length);
const noCode = rows.filter(r => (r.method==='json'||r.method==='jsonp'||r.method==='send') && r.codeExpr === null);
console.log("SITES WITHOUT code field:", noCode.length);
for (const r of noCode) console.log(`  ${r.file}:${r.line} status=${r.status} [] ${r.snippet}`);
