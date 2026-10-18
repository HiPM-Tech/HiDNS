import { describe, it, expect, vi } from 'vitest';
import { authorize, AuthorizationError, isCombinationAllowed, createSystemPrincipal } from './auth';
import type { AuthorizeDeps, Principal, ActionMeta } from './auth';
import type { ActionClass } from '../types/namespace';
import type { AvailableService } from '../types/token';

const META: Record<string, ActionMeta> = {
  'dns.record.update': { name: 'dns.record.update', actionClass: 'dns.record.write', service: 'records.write', dslVisible: true },
  'dns.record.delete': { name: 'dns.record.delete', actionClass: 'dns.record.write', service: 'records.write', dslVisible: false },
  'http.outbound.fetch': { name: 'http.outbound.fetch', actionClass: 'http', service: 'network.fetch', dslVisible: true },
};

function makeDeps(overrides: Partial<AuthorizeDeps> = {}): AuthorizeDeps & { audit: ReturnType<typeof vi.fn> } {
  const audit = vi.fn(async () => undefined);
  return {
    lookupAction: (name: string) => META[name] ?? null,
    audit,
    rateLimit: () => true,
    now: () => 1_700_000_000_000,
    newTraceId: () => 'trace-1',
    ...overrides,
  } as AuthorizeDeps & { audit: ReturnType<typeof vi.fn> };
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    kind: 'user',
    id: 'u1',
    role: 'user',
    services: ['records.write', 'network.fetch'] as AvailableService[],
    allowedDomains: '*',
    ...overrides,
  };
}

async function expectStatus(fn: () => Promise<unknown>, status: number): Promise<void> {
  await expect(fn()).rejects.toThrow(AuthorizationError);
  await fn().catch((error: AuthorizationError) => expect(error.status).toBe(status));
}

describe('authorize 八步裁决', () => {
  it('1. 未知动作 → 404（禁止通配匹配）', async () => {
    await expectStatus(() => authorize('dns.record.*', principal(), undefined, makeDeps()), 404);
  });

  it('2. 缺少执行身份 → 401', async () => {
    await expectStatus(
      () => authorize('dns.record.update', { ...principal(), id: '' }, undefined, makeDeps()),
      401,
    );
  });

  it('2b. 身份过期 → 401', async () => {
    await expectStatus(
      () => authorize('dns.record.update', principal({ expiresAt: 1 }), undefined, makeDeps()),
      401,
    );
  });

  it('3. 缺少服务权限 → 403', async () => {
    await expectStatus(
      () => authorize('dns.record.update', principal({ services: [] }), undefined, makeDeps()),
      403,
    );
  });

  it('4. 域名不在允许列表 → 403', async () => {
    await expectStatus(
      () =>
        authorize('dns.record.update', principal({ allowedDomains: ['a.com'] }), { domainName: 'b.com' }, makeDeps()),
      403,
    );
  });

  it('5. domain.changed 触发写动作 → 422；record.changed 允许', async () => {
    await expectStatus(
      () =>
        authorize('dns.record.update', principal(), undefined, makeDeps(), {
          trigger: 'event',
          triggerType: 'domain.changed',
        }),
      422,
    );
    const ctx = await authorize('dns.record.update', principal(), undefined, makeDeps(), {
      trigger: 'event',
      triggerType: 'record.changed',
    });
    expect(ctx.action).toBe('dns.record.update');
    expect(isCombinationAllowed('domain.changed', 'dns.record.write' as ActionClass)).toBe(false);
    expect(isCombinationAllowed('record.changed', 'dns.record.write' as ActionClass)).toBe(true);
  });

  it('6. dslVisible=false 且 DSL 通道 → 403', async () => {
    const deps = makeDeps();
    const ctx = await authorize('dns.record.delete', principal(), undefined, deps, { trigger: 'api' });
    expect(ctx.action).toBe('dns.record.delete');
    await expectStatus(
      () => authorize('dns.record.delete', principal(), undefined, makeDeps(), { trigger: 'event' }),
      403,
    );
  });

  it('7. 速率超限 → 429', async () => {
    await expectStatus(
      () => authorize('dns.record.update', principal(), undefined, makeDeps({ rateLimit: () => false })),
      429,
    );
  });

  it('8. write-ahead 审计失败 → 拒绝执行', async () => {
    const deps = makeDeps({ audit: vi.fn(async () => { throw new Error('audit down'); }) });
    await expect(authorize('dns.record.update', principal(), undefined, deps)).rejects.toThrow('audit down');
  });

  it('9. 全部通过 → 签发 ActionContext 并落审计', async () => {
    const deps = makeDeps();
    const ctx = await authorize('http.outbound.fetch', principal(), { domainName: 'a.com' }, deps);
    expect(ctx.action).toBe('http.outbound.fetch');
    expect(ctx.actionClass).toBe('http');
    expect(deps.audit).toHaveBeenCalledTimes(1);
  });

  it('10. 系统身份权限为枚举白名单，不含管理员通配', () => {
    const sys = createSystemPrincipal(['records.read']);
    expect(sys.role).toBe('user');
    expect(sys.allowedDomains).toEqual([]);
    expect(sys.services).toEqual(['records.read']);
  });
});