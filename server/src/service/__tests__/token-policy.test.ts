import { describe, expect, it } from 'vitest';
import { normalizeTokenDomains, resolveTokenPolicy } from '../token-policy';

describe('resolveTokenPolicy', () => {
  it('未传服务与角色时沿用历史默认：全部服务 + 创建者角色', () => {
    expect(resolveTokenPolicy({ userRole: 2 })).toEqual({ ok: true, services: ['*'], maxRole: 2 });
  });

  it('显式服务清单原样保留（去空白、丢弃空串）', () => {
    expect(resolveTokenPolicy({ allowedServices: ['dns', ' mcp ', ''], userRole: 1 }))
      .toEqual({ ok: true, services: ['dns', 'mcp'], maxRole: 1 });
  });

  it('只有空串的服务清单 → 400', () => {
    const result = resolveTokenPolicy({ allowedServices: ['  ', ''], userRole: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it('角色上限超过创建者 → 403；非法值 → 400', () => {
    const escalate = resolveTokenPolicy({ maxRole: 3, userRole: 1 });
    expect(escalate.ok).toBe(false);
    if (!escalate.ok) expect(escalate.status).toBe(403);

    const invalid = resolveTokenPolicy({ maxRole: 1.5, userRole: 2 });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.status).toBe(400);
  });

  it('允许降级签发（max_role 低于创建者）', () => {
    expect(resolveTokenPolicy({ maxRole: 0, userRole: 2 })).toEqual({ ok: true, services: ['*'], maxRole: 0 });
  });
});

describe('normalizeTokenDomains', () => {
  it('只保留正整数 id', () => {
    expect(normalizeTokenDomains([1, '2', 0, -1, 'x', null])).toEqual([1, 2]);
    expect(normalizeTokenDomains(undefined)).toEqual([]);
  });
});
