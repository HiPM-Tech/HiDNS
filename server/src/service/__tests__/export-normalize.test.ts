import { describe, expect, it } from 'vitest';
import { escapeCSV } from '../auditExport';
import { normalizeDomain } from '../../utils/domain';

/**
 * 导出与归一化的注入/一致性回归（第二轮 P1/P2）：
 * - CSV 公式注入：以 = + - @ 开头的单元格会被 Excel 当公式执行；
 * - NFKC：全角/兼容字符必须折叠，否则「看起来一样」的域名能绕过判重。
 */
describe('escapeCSV 公式注入', () => {
  it('危险前缀被中和', () => {
    expect(escapeCSV('=cmd|calc')).toBe("'=cmd|calc");
    expect(escapeCSV('+1+1')).toBe("'+1+1");
    expect(escapeCSV('-2')).toBe("'-2");
    expect(escapeCSV('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(escapeCSV('\tfoo')).toBe("'\tfoo");
  });

  it('普通文本与含逗号/引号仍按 RFC 引号包裹', () => {
    expect(escapeCSV('hello')).toBe('hello');
    expect(escapeCSV('a,b')).toBe('"a,b"');
    expect(escapeCSV('say "hi"')).toBe('"say ""hi"""');
  });
});

describe('normalizeDomain 的 NFKC', () => {
  it('全角字母/数字折叠为半角', () => {
    expect(normalizeDomain('ｅｘａｍｐｌｅ.com')).toBe('example.com');
    expect(normalizeDomain('ＥＸＡＭＰＬＥ.ＣＯＭ')).toBe('example.com');
  });

  it('兼容字符与末尾点、大小写一起归一', () => {
    expect(normalizeDomain('Example.COM.')).toBe('example.com');
  });
});
