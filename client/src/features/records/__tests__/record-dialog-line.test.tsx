import { describe, expect, it } from 'vitest';
import { displayLine, normalizeLineOptions } from '../line-options';

const lines = [
  { id: '0', name: '默认' },
  { id: '1', name: '电信' },
  { id: '1', name: '电信（重复）' },
  { id: 'default_view', name: '默认' },
];

describe('线路下拉归一', () => {
  it('过滤默认线路 id 并去重', () => {
    expect(normalizeLineOptions(lines, '0')).toEqual([
      { id: '1', name: '电信' },
      { id: 'default_view', name: '默认' },
    ]);
  });

  it('编辑记录时默认线路展示为「默认线路」', () => {
    expect(displayLine('0', '0')).toBe('');
    expect(displayLine('默认', '0')).toBe('默认');
    expect(displayLine('1', '0')).toBe('1');
  });
});
