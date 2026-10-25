import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeLine } from '../line-normalizer';
import { providerDefinitions } from '../providers/registry';

describe('线路归一中间层', () => {
  it('空 / 0 / 默认 都归一为适配器默认线路', () => {
    expect(normalizeLine(undefined, '默认')).toBe('默认');
    expect(normalizeLine('', '默认')).toBe('默认');
    expect(normalizeLine('0', '默认')).toBe('默认');
    expect(normalizeLine('默认', '默认')).toBe('默认');
    expect(normalizeLine(' 0 ', 'default_view')).toBe('default_view');
  });

  it('真实线路原样透传，不做上游字典映射', () => {
    expect(normalizeLine('电信', '默认')).toBe('电信');
    expect(normalizeLine('default_view', 'default')).toBe('default_view');
    expect(normalizeLine('10=0', '默认')).toBe('10=0');
  });

  it('每个适配器内部声明 DEFAULT_LINE，且与 registry 的 defaultLine 一致', () => {
    const dir = path.resolve(__dirname, '../providers');
    const mismatched: string[] = [];
    for (const definition of providerDefinitions) {
      const file = path.join(dir, definition.type, 'adapter.ts');
      if (!fs.existsSync(file)) continue;
      const source = fs.readFileSync(file, 'utf8');
      const match = source.match(/export const DEFAULT_LINE = '([^']+)'/);
      if (!match) { mismatched.push(definition.type + ':missing'); continue; }
      if (match[1] !== definition.defaultLine) mismatched.push(`${definition.type}:${match[1]}!=${definition.defaultLine}`);
    }
    expect(mismatched).toEqual([]);
  });
});
