import { describe, expect, it } from 'vitest';
import { pickCredentialResponse } from '../webauthn';

/**
 * 回归：前端提交 { credential } 包装时，若把 body 直接交给 verifyRegistrationResponse，
 * simplewebauthn 会读不到 id 并抛 Missing credential ID。
 */
describe('pickCredentialResponse', () => {
  it('取出 { credential } 里的凭证', () => {
    const credential = { id: 'cred-1', rawId: 'cred-1', type: 'public-key' };
    expect(pickCredentialResponse({ credential })).toBe(credential);
  });

  it('裸对象原样返回（兼容直接提交凭证）', () => {
    const credential = { id: 'cred-2', rawId: 'cred-2', type: 'public-key' };
    expect(pickCredentialResponse(credential)).toBe(credential);
  });

  it('null / 数组等异常输入不抛错', () => {
    expect(pickCredentialResponse(null)).toBeNull();
    expect(pickCredentialResponse([])).toEqual([]);
  });
});