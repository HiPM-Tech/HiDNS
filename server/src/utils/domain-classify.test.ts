import { describe, expect, it } from 'vitest';
import { getRootDomain, normalizeDomain } from './domain';

/**
 * 域名分类（顶域 / 子域）。
 *
 * 这项覆盖原先来自已腐化的 tests/domain-filter.test.ts（它建真实 sqlite 再查表，
 * 重构后 schema 由 DSM 管理、fixture 与列名全部过期，无法直接跑）。
 * 分类逻辑本身是纯函数：`normalizeDomain(name) === getRootDomain(name)` 即顶域。
 */
function classify(name: string): 'apex' | 'subdomain' {
  const normalized = normalizeDomain(name);
  return normalized === getRootDomain(normalized) ? 'apex' : 'subdomain';
}

describe('域名分类（顶域 / 子域）', () => {
  it('两部分域名是顶域', () => {
    expect(classify('example.com')).toBe('apex');
    expect(classify('test.org')).toBe('apex');
  });

  it('带前缀的是子域', () => {
    expect(classify('sub.example.com')).toBe('subdomain');
    expect(classify('deep.sub.example.com')).toBe('subdomain');
    expect(classify('www.example.com')).toBe('subdomain');
  });

  it('大小写与末尾点归一化后仍按同一口径分类', () => {
    expect(classify('EXAMPLE.COM.')).toBe('apex');
    expect(classify('WWW.Example.Com')).toBe('subdomain');
  });

  it('getRootDomain 对多级域名取后两段', () => {
    expect(getRootDomain('a.b.c.example.com')).toBe('example.com');
    expect(getRootDomain('example.com.')).toBe('example.com');
  });
});
