import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_NAMESPACE_CLAIMS } from '../../../namespace-registry';
import { MODULES, ALL_ACTIONS, HANDLERS, lookupActionDeclaration } from '../registry';
import { validateAll } from '../validate-names';
import { TOP_NAMESPACES, RESERVED_TOP_NAMESPACES } from '../../../types/namespace';

const SRC_ROOT = join(__dirname, '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('动作命名空间', () => {
  it('A0–A10：全部校验通过', () => {
    expect(validateAll(ALL_NAMESPACE_CLAIMS, MODULES, ALL_ACTIONS)).toEqual([]);
  });

  it('白名单非空，预留前缀未被认领', () => {
    expect(TOP_NAMESPACES.length).toBeGreaterThan(0);
    const claimed = new Set(ALL_NAMESPACE_CLAIMS.map((claim) => claim.top));
    for (const reserved of RESERVED_TOP_NAMESPACES) {
      expect(claimed.has(reserved as never)).toBe(false);
    }
  });

  it('A4/A8：声明名唯一，且与 handler 集合双向一致', () => {
    const declared = ALL_ACTIONS.map((a) => a.name);
    expect(new Set(declared).size).toBe(declared.length);
    const handlerNames = Object.keys(HANDLERS);
    expect(new Set(handlerNames).size).toBe(handlerNames.length);
    expect([...handlerNames].sort()).toEqual([...declared].sort());
  });

  it('精确查找：禁止通配与前缀匹配', () => {
    expect(lookupActionDeclaration('dns.record.list')).not.toBeNull();
    expect(lookupActionDeclaration('dns.record.*')).toBeNull();
    expect(lookupActionDeclaration('dns.record')).toBeNull();
    expect(lookupActionDeclaration('DNS.RECORD.LIST')).toBeNull();
  });

  it('A11：routes / service / providers 不得直连 workflow 动作实现', () => {
    const offenders: string[] = [];
    for (const dir of ['routes', 'service', join('lib', 'dns', 'providers')]) {
      for (const file of walk(join(SRC_ROOT, dir))) {
        const source = readFileSync(file, 'utf8');
        if (/from\s+['"][^'"]*workflow\/actions\/(?!registry|types)/.test(source)) {
          offenders.push(file.replace(SRC_ROOT, 'src'));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('全局主核心不得 import 任何子系统', () => {
    const core = readFileSync(join(SRC_ROOT, 'types', 'namespace.ts'), 'utf8');
    const imports = core.split('\n').filter((line) => line.trimStart().startsWith('import '));
    expect(imports).toEqual([]);
  });
});