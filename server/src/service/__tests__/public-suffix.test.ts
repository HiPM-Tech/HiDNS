import { describe, expect, it, beforeEach } from 'vitest';
import {
  BUILTIN_SUFFIXES,
  isPublicSuffix,
  parsePublicSuffixList,
  __setPublicSuffixesForTests,
} from '../public-suffix';
import { getPublicSuffix, getRootDomain } from '../whois/domain-utils';

/**
 * 公共后缀：解析（PSL 格式）、通配规则、以及域名根域的动态计算。
 *
 * 后缀集合的来源是 DB 表 public_suffixes（定时任务从上游下拉），
 * 这里用 __setPublicSuffixesForTests 注入等价集合，验证「集合变化 → 根域跟着变」。
 */
describe('parsePublicSuffixList', () => {
  it('忽略注释/空行/例外规则，保留通配', () => {
    const text = [
      '// ===BEGIN ICANN DOMAINS===',
      'com',
      'co.uk',
      '*.ck',
      '!www.ck',
      '',
      '// comment',
      'dpdns.org',
    ].join('\n');
    const parsed = parsePublicSuffixList(text);
    expect(parsed).toContain('com');
    expect(parsed).toContain('co.uk');
    expect(parsed).toContain('*.ck');
    expect(parsed).toContain('dpdns.org');
    expect(parsed).not.toContain('!www.ck');
    expect(parsed).not.toContain('// ===BEGIN ICANN DOMAINS===');
  });
});

describe('IDN / xn-- 适配', () => {
  it('Unicode 后缀在解析时转成 punycode，域名归一化后能命中', () => {
    const parsed = parsePublicSuffixList('公司.cn\n中国\n');
    expect(parsed).toContain('xn--55qx5d.cn');
    expect(parsed).toContain('xn--fiqs8s');
  });

  it('中文域名的根域是 punycode 形式，回显由 toUnicode 负责', () => {
    __setPublicSuffixesForTests(['xn--55qx5d.cn', 'xn--fiqs8s', 'com', 'cn']);
    // 例子.公司.cn：公司.cn 是公共后缀 → 可注册域就是自身
    expect(getRootDomain('例子.公司.cn')).toBe('xn--fsqu00a.xn--55qx5d.cn');
    expect(getRootDomain('a.例子.公司.cn')).toBe('xn--fsqu00a.xn--55qx5d.cn');
    // 例子.中国：中国是 TLD
    expect(getRootDomain('例子.中国')).toBe('xn--fsqu00a.xn--fiqs8s');
  });

  it('已经是 xn-- 形式的输入与 Unicode 输入结果一致', () => {
    __setPublicSuffixesForTests(['xn--55qx5d.cn', 'xn--fsqu00a.xn--55qx5d.cn']);
    expect(getRootDomain('xn--fsqu00a.xn--55qx5d.cn')).toBe('xn--fsqu00a.xn--55qx5d.cn');
    expect(getRootDomain('例子.公司.cn')).toBe('xn--fsqu00a.xn--55qx5d.cn');
  });
});

describe('isPublicSuffix（通配规则）', () => {
  beforeEach(() => __setPublicSuffixesForTests([...BUILTIN_SUFFIXES, '*.ck']));

  it('精确命中', () => {
    expect(isPublicSuffix('com')).toBe(true);
    expect(isPublicSuffix('cc.cd')).toBe(true);
  });

  it('*.ck 让任意 x.ck 都算公共后缀', () => {
    expect(isPublicSuffix('ck')).toBe(false);
    expect(isPublicSuffix('x.ck')).toBe(true);
  });
});

describe('getRootDomain（后缀集合可动态变化）', () => {
  it('cc.cd / dpdns.org 这类多段后缀不被截断', () => {
    __setPublicSuffixesForTests([...BUILTIN_SUFFIXES]);
    expect(getPublicSuffix('foo.cc.cd')).toBe('cc.cd');
    expect(getRootDomain('bar.foo.cc.cd')).toBe('foo.cc.cd');
    expect(getRootDomain('y.x.dpdns.org')).toBe('x.dpdns.org');
  });

  it('上游新增后缀后，同一域名立刻按新规则计算', () => {
    // 只有 bar 时：x.foo.bar 的可注册域是 foo.bar
    __setPublicSuffixesForTests([...BUILTIN_SUFFIXES, 'bar']);
    expect(getRootDomain('x.foo.bar')).toBe('foo.bar');

    // 模拟定时任务把两段后缀 foo.bar 拉进库：可注册域变成 x.foo.bar
    __setPublicSuffixesForTests([...BUILTIN_SUFFIXES, 'bar', 'foo.bar']);
    expect(getRootDomain('x.foo.bar')).toBe('x.foo.bar');
  });

  it('通配后缀下根域保留完整标签', () => {
    __setPublicSuffixesForTests([...BUILTIN_SUFFIXES, '*.ck']);
    expect(getRootDomain('a.x.ck')).toBe('a.x.ck');
    expect(getRootDomain('x.ck')).toBe('x.ck');
  });
});
