import { describe, it, expect } from 'vitest';
import { assertExtDomainAllowed } from '../ext-guard';

const principal = (read: number[], write: number[]) => ({
  kind: 'user' as const,
  id: '1',
  role: 'admin' as const,
  services: [],
  allowedDomains: [] as string[],
  allowedDomainIds: read,
  allowedWriteDomainIds: write,
});

describe('扩展动作的域名级校验', () => {
  it('ext.write 只认可写集合：仅读授权 → 403', () => {
    expect(() => assertExtDomainAllowed(principal([11], []), 11, 'ext.write')).toThrowError(/域名权限不足/);
  });

  it('ext.write 命中可写集合 → 放行', () => {
    expect(assertExtDomainAllowed(principal([], [11]), 11, 'ext.write')).toBe(11);
  });

  it('ext.read 用读集合', () => {
    expect(assertExtDomainAllowed(principal([11], []), 11, 'ext.read')).toBe(11);
    expect(() => assertExtDomainAllowed(principal([], [11]), 11, 'ext.read')).toThrowError(/域名权限不足/);
  });

  it('缺少集合 → fail-closed 403', () => {
    expect(() =>
      assertExtDomainAllowed({ ...principal([], []), allowedWriteDomainIds: undefined }, 11, 'ext.write'),
    ).toThrowError(/缺少可写域名集合/);
  });

  it('缺少域名参数 → 400', () => {
    expect(() => assertExtDomainAllowed(principal([1], [1]), undefined, 'ext.read')).toThrowError(/domainId/);
  });
});