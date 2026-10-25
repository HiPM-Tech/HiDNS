import { describe, expect, it } from 'vitest';
import { getPublicSuffix, getRootDomain, groupDomains } from '../domain-utils';

/**
 * 域名分组与公共后缀。
 *
 * 背景（旧设计的要求）：域名列表按「可注册域」虚拟分组——
 * a.e.com / e.com / b.e.com 归到组头 <e.com>；
 * 难点在于公共后缀不止一段：cc.cd、dpdns.org、us.kg 这类后缀下的
 * 可注册域必须整段保留，不能只取最后两段。
 */
describe('getPublicSuffix', () => {
  it('普通 TLD 取最后一段', () => {
    expect(getPublicSuffix('e.com')).toBe('com');
    expect(getPublicSuffix('a.e.com')).toBe('com');
  });

  it('多段公共后缀整段命中', () => {
    expect(getPublicSuffix('foo.cc.cd')).toBe('cc.cd');
    expect(getPublicSuffix('x.dpdns.org')).toBe('dpdns.org');
    expect(getPublicSuffix('a.b.dpdns.org')).toBe('dpdns.org');
    expect(getPublicSuffix('example.co.uk')).toBe('co.uk');
  });
});

describe('getRootDomain（可注册域）', () => {
  it('子域归到父域', () => {
    expect(getRootDomain('a.e.com')).toBe('e.com');
    expect(getRootDomain('b.e.com')).toBe('e.com');
    expect(getRootDomain('deep.a.e.com')).toBe('e.com');
  });

  it('公共后缀下的域名不被截断成后缀本身', () => {
    expect(getRootDomain('foo.cc.cd')).toBe('foo.cc.cd');
    expect(getRootDomain('bar.foo.cc.cd')).toBe('foo.cc.cd');
    expect(getRootDomain('x.dpdns.org')).toBe('x.dpdns.org');
    expect(getRootDomain('y.x.dpdns.org')).toBe('x.dpdns.org');
  });
});

describe('groupDomains（虚拟分组）', () => {
  const domains = [
    { id: 1, name: 'a.e.com' },
    { id: 2, name: 'e.com' },
    { id: 3, name: 'b.e.com' },
    { id: 4, name: 'other.net' },
  ];

  it('父域在列表时按 <e.com> 分组，父域排在组内第一', () => {
    const { groups, standalone } = groupDomains(domains);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('e.com');
    expect(groups[0].parent?.name).toBe('e.com');
    expect(groups[0].children.map((d) => d.name)).toEqual(['e.com', 'a.e.com', 'b.e.com']);
    expect(standalone.map((d) => d.name)).toEqual(['other.net']);
  });

  it('默认模式：父域不在列表时不造组（各自独立）', () => {
    const { groups, standalone } = groupDomains([
      { id: 1, name: 'a.e.com' },
      { id: 3, name: 'b.e.com' },
    ]);
    expect(groups).toHaveLength(0);
    expect(standalone).toHaveLength(2);
  });

  it('virtualRoots：无条件按可注册域造组，组头是虚拟行', () => {
    const { groups, standalone } = groupDomains(
      [{ id: 1, name: 'a.e.com' }, { id: 3, name: 'b.e.com' }, { id: 5, name: 'other.net' }],
      undefined,
      { virtualRoots: true },
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('e.com');
    expect(groups[0].parent).toBeNull();
    expect(groups[0].children.map((d) => d.name)).toEqual(['a.e.com', 'b.e.com']);
    expect(standalone.map((d) => d.name)).toEqual(['other.net']);
  });

  it('virtualRoots：父域存在时仍把父域排在组内第一', () => {
    const { groups } = groupDomains(domains, undefined, { virtualRoots: true });
    expect(groups[0].parent?.name).toBe('e.com');
    expect(groups[0].children.map((d) => d.name)).toEqual(['e.com', 'a.e.com', 'b.e.com']);
  });

  it('公共后缀下的两个域名互不分组', () => {
    const { groups, standalone } = groupDomains([
      { id: 1, name: 'x.dpdns.org' },
      { id: 2, name: 'y.dpdns.org' },
    ]);
    expect(groups).toHaveLength(0);
    expect(standalone).toHaveLength(2);
  });

  it('同名域名挂多个账号时不分组（避免组头与同名独立行重复）', () => {
    const { groups, standalone } = groupDomains([
      { id: 1, name: 'e.com' },
      { id: 2, name: 'e.com' },
      { id: 3, name: 'a.e.com' },
    ]);
    expect(groups).toHaveLength(0);
    expect(standalone).toHaveLength(3);
  });

  it('置顶的子域排在父域之后、其它子域之前', () => {
    const { groups } = groupDomains(domains, [3]);
    expect(groups[0].children.map((d) => d.name)).toEqual(['e.com', 'b.e.com', 'a.e.com']);
  });
});
