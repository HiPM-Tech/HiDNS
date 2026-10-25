import { describe, expect, it } from 'vitest';
import { pickOAuthProvider } from '../auth';

describe('OAuth 登录提供商选择', () => {
  it('未显式指定时回落到第一个已启用提供商（只开 Logto 的部署）', () => {
    expect(pickOAuthProvider(undefined, [{ key: 'logto' }])).toBe('logto');
  });

  it('显式指定已启用的提供商', () => {
    expect(pickOAuthProvider('logto', [{ key: 'logto' }])).toBe('logto');
    expect(pickOAuthProvider('custom', [{ key: 'custom' }, { key: 'logto' }])).toBe('custom');
  });

  it('显式指定未启用的提供商直接报错（不再静默走默认）', () => {
    expect(() => pickOAuthProvider('custom', [{ key: 'logto' }])).toThrow(/not enabled/);
  });

  it('没有任何提供商启用时保持历史默认 custom，由 assertOAuthEnabled 给出 disabled', () => {
    expect(pickOAuthProvider(undefined, [])).toBe('custom');
  });
});
