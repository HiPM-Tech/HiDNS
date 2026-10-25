import { describe, expect, it } from 'vitest';
import { normalizeAndValidateDomainNames } from '../domains';
import { validateRecordInput } from '../records';

/**
 * 入库前的名称校验（对抗测试 P1-5 / P1-6）：
 * 此前 a..b / -bad.com / bad_name!.com / xn--zzzz / 64 字符标签 / ttl=-1 / mx=99999 都能落库。
 */
describe('normalizeAndValidateDomainNames', () => {
  it('接受正常域名与 IDN，并归一化成 punycode', () => {
    const { accepted, rejected } = normalizeAndValidateDomainNames([
      { name: 'example.com' },
      { name: '例子.公司.cn' },
      { name: 'Sub.Example.COM' },
    ]);
    expect(rejected).toEqual([]);
    expect(accepted).toEqual(['example.com', 'xn--fsqu00a.xn--55qx5d.cn', 'sub.example.com']);
  });

  it('拒绝空、连续点、首尾连字符与非法字符', () => {
    const { accepted, rejected } = normalizeAndValidateDomainNames([
      { name: 'a..b' },
      { name: '-bad.com' },
      { name: 'bad-.com' },
      { name: 'bad_name!.com' },
      { name: '' },
      { name: 'ok.com' },
    ]);
    expect(accepted).toEqual(['ok.com']);
    expect(rejected).toHaveLength(5);
  });

  it('同一域名重复输入只保留一条', () => {
    const { accepted } = normalizeAndValidateDomainNames([{ name: 'a.com' }, { name: 'A.COM' }]);
    expect(accepted).toEqual(['a.com']);
  });
});

describe('validateRecordInput', () => {
  it('接受正常记录（含 @ 与通配）', () => {
    expect(validateRecordInput({ name: '@', type: 'A', value: '1.2.3.4', ttl: 600 })).toBeNull();
    expect(validateRecordInput({ name: '*', type: 'A', value: '1.2.3.4' })).toBeNull();
    expect(validateRecordInput({ name: 'www', type: 'A', value: '1.2.3.4', ttl: 1, mx: 0, weight: 65535 })).toBeNull();
  });

  it('拒绝空白名、连续点、超长标签与非法字符', () => {
    expect(validateRecordInput({ name: '   ', type: 'A', value: '1.1.1.1' })).toBeTruthy();
    expect(validateRecordInput({ name: 'a..b', type: 'A', value: '1.1.1.1' })).toBe('记录名不能包含连续的点');
    expect(validateRecordInput({ name: 'a'.repeat(64), type: 'A', value: '1.1.1.1' })).toContain('63');
    // 下划线是合法的（_dmarc / _acme-challenge），真正的非法字符是空格与感叹号
    expect(validateRecordInput({ name: 'bad name', type: 'A', value: '1.1.1.1' })).toContain('非法字符');
    expect(validateRecordInput({ name: 'bad!name', type: 'A', value: '1.1.1.1' })).toContain('非法字符');
    expect(validateRecordInput({ name: '_dmarc', type: 'TXT', value: 'v=DMARC1' })).toBeNull();
    expect(validateRecordInput({ name: '-bad', type: 'A', value: '1.1.1.1' })).toContain('-');
  });

  it('拒绝非法 TTL / MX / 权重', () => {
    expect(validateRecordInput({ name: 'www', type: 'A', value: '1.1.1.1', ttl: -1 })).toContain('TTL');
    expect(validateRecordInput({ name: 'www', type: 'A', value: '1.1.1.1', ttl: 1.5 })).toContain('TTL');
    expect(validateRecordInput({ name: 'www', type: 'MX', value: 'mail.x.com', mx: 99999 })).toContain('MX');
    expect(validateRecordInput({ name: 'www', type: 'SRV', value: 'x', weight: -1 })).toContain('WEIGHT');
  });
});
