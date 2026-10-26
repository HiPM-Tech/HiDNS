import { describe, expect, it } from 'vitest';
import { normalizeTokenDomains, resolveTokenPolicy } from '../token-policy';

describe('resolveTokenPolicy', () => {
  it('未传服务与角色时沿用历史默认：全部服务 + 创建者角色', () => {
    expect(resolveTokenPolicy({ userRole: 2 })).toEqual({ ok: true, services: { dns: ['*'], mcp: ['*'] }, maxRole: 2 });
  });

  it('保留细粒度权限并去重', () => {
    expect(resolveTokenPolicy({ allowedServices: { dns: ['records.read', 'records.read'], mcp: ['*'] }, userRole: 1 }))
      .toEqual({ ok: true, services: { dns: ['records.read'], mcp: ['*'] }, maxRole: 1 });
  });

  it.each([['dns'], [], null, 'dns', { other: ['*'] }, { dns: ['records.wirte'] },
    { dns: '*' }, { dns: [1] }, { mcp: ['tools.call'] }, { mcp: [] }].map(allowedServices => ({ allowedServices })))('非法服务结构 → 400 ($allowedServices)', ({ allowedServices }) => {
    const result = resolveTokenPolicy({ allowedServices, userRole: 1 });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it('显式空配置不提升为全部权限', () => {
    expect(resolveTokenPolicy({ allowedServices: {}, userRole: 1 })).toMatchObject({ ok: true, services: {} });
    expect(resolveTokenPolicy({ allowedServices: { dns: [] }, userRole: 1 }))
      .toMatchObject({ ok: true, services: { dns: [] } });
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
    expect(resolveTokenPolicy({ maxRole: 0, userRole: 2 })).toEqual({ ok: true, services: { dns: ['*'], mcp: ['*'] }, maxRole: 0 });
  });
});

describe('normalizeTokenDomains', () => {
  it('只保留正整数 id', () => {
    expect(normalizeTokenDomains([1, '2', 0, -1, 'x', null])).toEqual([1, 2]);
    expect(normalizeTokenDomains(undefined)).toEqual([]);
  });
});
