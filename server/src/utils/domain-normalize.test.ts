import { describe, expect, it } from 'vitest';
import { normalizeDomain, toPunycode } from './domain';

/**
 * IDN 归一化。
 *
 * 同一个域名可以有 NFC / NFD 两种 Unicode 写法（重音字符的组合方式不同），
 * 不归一化会生成两个不同的 Punycode —— 这会同时打穿「同域判重、域名白名单、分组」。
 */
describe('normalizeDomain 的 Unicode 归一化', () => {
  it('NFC 与 NFD 视为同一域名', () => {
    const nfc = 'caf\u00e9.com';      // café.com（单码点）
    const nfd = 'cafe\u0301.com';     // cafe + 组合重音
    expect(normalizeDomain(nfc)).toBe(normalizeDomain(nfd));
    expect(toPunycode(nfc)).toBe(toPunycode(nfd));
  });

  it('中文域名归一化后是稳定的 punycode', () => {
    expect(normalizeDomain('例子.中国')).toBe('xn--fsqu00a.xn--fiqs8s');
    expect(normalizeDomain('例子.中国.')).toBe('xn--fsqu00a.xn--fiqs8s');
    expect(normalizeDomain('例子.中国')).toBe(normalizeDomain('xn--fsqu00a.xn--fiqs8s'));
  });

  it('大小写与末尾点仍被归一', () => {
    expect(normalizeDomain('EXAMPLE.COM.')).toBe('example.com');
  });
});
