import { describe, expect, it } from 'vitest';
import { mergeMaskedConfig, parseConfigRecord, MASKED_CONFIG_VALUE } from '../account-config';

describe('parseConfigRecord', () => {
  it('兼容字符串与对象两种存储形态', () => {
    expect(parseConfigRecord('{"a":"1"}')).toEqual({ a: '1' });
    expect(parseConfigRecord({ a: '1' })).toEqual({ a: '1' });
  });

  it('坏数据与空值按空对象处理', () => {
    expect(parseConfigRecord('not-json')).toEqual({});
    expect(parseConfigRecord(null)).toEqual({});
    expect(parseConfigRecord(undefined)).toEqual({});
    expect(parseConfigRecord([1, 2])).toEqual({});
  });
});

describe('mergeMaskedConfig', () => {
  it('掩码占位沿用原值', () => {
    const merged = mergeMaskedConfig({ token: 'real-secret', zone: 'z1' }, { token: MASKED_CONFIG_VALUE, zone: 'z2' });
    expect(merged).toEqual({ token: 'real-secret', zone: 'z2' });
  });

  it('原配置没有该键时丢弃占位符，不把 *** 写库', () => {
    const merged = mergeMaskedConfig({ a: '1' }, { b: MASKED_CONFIG_VALUE });
    expect(merged).toEqual({});
  });

  it('普通值覆盖且不保留旧键', () => {
    const merged = mergeMaskedConfig({ a: '1', b: '2' }, { a: '3' });
    expect(merged).toEqual({ a: '3' });
  });
});
