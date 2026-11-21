import { describe, expect, it } from 'vitest';
import { describeWebAuthnError } from '../webauthn-error';

describe('describeWebAuthnError', () => {
  it('NotAllowedError 提示完成系统验证或改用密码', () => {
    const message = describeWebAuthnError(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
    expect(message).toContain('Touch ID');
    expect(message).toContain('密码登录');
  });

  it('NotSupportedError 提示换浏览器或插安全密钥', () => {
    const message = describeWebAuthnError(Object.assign(new Error('x'), { name: 'NotSupportedError' }));
    expect(message).toContain('安全密钥');
  });

  it('SecurityError 提示 HTTPS / 反向代理域名', () => {
    const message = describeWebAuthnError(Object.assign(new Error('x'), { name: 'SecurityError' }));
    expect(message).toContain('HTTPS');
  });

  it('未知错误保留原始 message', () => {
    expect(describeWebAuthnError(new Error('boom'))).toBe('boom');
  });

  it('非 Error 值给出兜底文案', () => {
    expect(describeWebAuthnError(undefined)).toContain('通行密钥');
  });
});