import { describe, expect, it } from 'vitest';
import { unwrapWebAuthnOptions } from '../webauthn-options';

describe('unwrapWebAuthnOptions', () => {
  it('服务端裸对象：直接返回，challenge 可见', () => {
    const options = unwrapWebAuthnOptions<{ challenge: string }>({ challenge: 'c1', rp: { id: 'x' } });
    expect(options.challenge).toBe('c1');
  });

  it('兼容被 { options } 包一层的情况', () => {
    const options = unwrapWebAuthnOptions<{ challenge: string }>({ options: { challenge: 'c2' } });
    expect(options.challenge).toBe('c2');
  });

  it('null / 数组等异常输入原样返回，不抛错', () => {
    expect(unwrapWebAuthnOptions<null>(null)).toBeNull();
    expect(unwrapWebAuthnOptions<unknown[]>([])).toEqual([]);
  });
});