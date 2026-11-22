import { describe, expect, it } from 'vitest';
import { hasServicePermission } from '../token';
import { resolveTokenPolicy, KNOWN_SERVICES } from '../token-policy';

function payload(allowedServices: string[]) {
  return { allowedServices } as Parameters<typeof hasServicePermission>[0];
}

describe('hasServicePermission（叠加动作位，issue #38）', () => {
  it('* 放行一切', () => {
    expect(hasServicePermission(payload(['*']), 'dns', 'write')).toBe(true);
    expect(hasServicePermission(payload(['*']), 'mcp', 'read')).toBe(true);
  });

  it('不带动作位的模块名视为全权限（历史令牌兼容）', () => {
    expect(hasServicePermission(payload(['dns']), 'dns', 'read')).toBe(true);
    expect(hasServicePermission(payload(['dns']), 'dns', 'write')).toBe(true);
  });

  it('dns:read 只放行读', () => {
    expect(hasServicePermission(payload(['dns:read']), 'dns', 'read')).toBe(true);
    expect(hasServicePermission(payload(['dns:read']), 'dns', 'write')).toBe(false);
  });

  it('dns:write 同时放行读（写隐含读）', () => {
    expect(hasServicePermission(payload(['dns:write']), 'dns', 'write')).toBe(true);
    expect(hasServicePermission(payload(['dns:write']), 'dns', 'read')).toBe(true);
  });

  it('动作位不跨模块', () => {
    expect(hasServicePermission(payload(['dns:write']), 'mcp', 'write')).toBe(false);
  });

  it('模块:* 等价于不带动作位', () => {
    expect(hasServicePermission(payload(['mcp:*']), 'mcp', 'write')).toBe(true);
  });
});

describe('resolveTokenPolicy 白名单', () => {
  it('已知服务通过', () => {
    const result = resolveTokenPolicy({ allowedServices: ['dns:read', 'mcp:write'], maxRole: 1, userRole: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.services).toEqual(['dns:read', 'mcp:write']);
  });

  it('未知服务被拒绝（此前任意字符串都能入库）', () => {
    const result = resolveTokenPolicy({ allowedServices: ['dns:delete-everything'], maxRole: 1, userRole: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('unknown allowed_services');
  });

  it('白名单覆盖全部预设', () => {
    expect([...KNOWN_SERVICES]).toEqual(expect.arrayContaining(['dns', 'dns:read', 'dns:write', 'mcp', 'mcp:read', 'mcp:write']));
  });

  // 第十轮评审 P0：显式空数组曾经被当成「未传」→ 静默回退成全权限 *
  it('显式空数组被拒绝，不回落成全权限', () => {
    const result = resolveTokenPolicy({ allowedServices: [], maxRole: 1, userRole: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.message).toContain('cannot be empty');
    }
  });

  it('null 与非数组同样被拒绝', () => {
    for (const bad of [null, 'dns', { a: 1 }]) {
      const result = resolveTokenPolicy({ allowedServices: bad, maxRole: 1, userRole: 3 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('must be an array');
    }
  });

  it('字段缺省仍沿用历史默认（兼容老客户端）', () => {
    const result = resolveTokenPolicy({ maxRole: 1, userRole: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.services).toEqual(['*']);
  });
});