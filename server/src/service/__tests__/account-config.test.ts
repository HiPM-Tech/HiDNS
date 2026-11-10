import { describe, expect, it } from 'vitest';
import { mergeMaskedConfig, parseConfigRecord, resolveCredentialState, stripHiddenConfig, MASKED_CONFIG_VALUE } from '../account-config';

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

describe('隐藏字段（hidden）', () => {
  it('合并时保留原有隐藏字段，并忽略客户端传值（防伪造会话）', () => {
    const merged = mergeMaskedConfig(
      { passkey: 'pk', sessionCookie: 'remember_token=abc' },
      { passkey: MASKED_CONFIG_VALUE, sessionCookie: 'forged=1' },
      ['sessionCookie'],
    );
    expect(merged).toEqual({ passkey: 'pk', sessionCookie: 'remember_token=abc' });
  });

  it('原配置没有隐藏字段时不凭空创建', () => {
    expect(mergeMaskedConfig({ passkey: 'pk' }, { passkey: 'new' }, ['sessionCookie']))
      .toEqual({ passkey: 'new' });
  });

  it('stripHiddenConfig 只剔除指定键，其余原样返回', () => {
    expect(stripHiddenConfig({ passkey: 'pk', sessionCookie: 'c', zone: 'z' }, ['sessionCookie']))
      .toEqual({ passkey: 'pk', zone: 'z' });
  });
});


describe('resolveCredentialState', () => {
  it('已配置通行密钥', () => {
    expect(resolveCredentialState({ passkey: '{"credentialId":"x"}' }, true)).toBe('passkey');
  });

  it('只有旧版会话凭证：提示可补但当前可用', () => {
    expect(resolveCredentialState({ rememberToken: 'legacy' }, true)).toBe('legacy');
  });

  it('两者都没有', () => {
    expect(resolveCredentialState({}, true)).toBe('missing');
  });

  it('空白字符串不算已配置', () => {
    expect(resolveCredentialState({ passkey: '   ', rememberToken: ' ' }, true)).toBe('missing');
  });

  it('未声明 passkey 字段的提供商返回 null（不对其他 provider 显示徽标）', () => {
    expect(resolveCredentialState({ apiKey: 'k' }, false)).toBeNull();
  });
});

