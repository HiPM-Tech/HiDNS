import { describe, expect, it } from 'vitest';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { defineApiModules, getExemptPrefixes, toManifest } from '../registry';
import { buildApiModules } from '../index';
import { createInitGate } from '../init-gate';
import type { ApiModule } from '../types';

function module(partial: Partial<ApiModule> & { id: string; prefix: string }): ApiModule {
  return {
    router: express.Router(),
    description: 'test module',
    ...partial,
  } as ApiModule;
}

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function runGate(
  gate: ReturnType<typeof createInitGate>,
  path: string,
  method = 'GET',
): { nextCalled: boolean; res: ReturnType<typeof fakeRes> } {
  const req = { path, method } as unknown as Request;
  const res = fakeRes();
  let nextCalled = false;
  gate(req, res as unknown as Response, (() => { nextCalled = true; }) as NextFunction);
  return { nextCalled, res };
}

describe('api registry', () => {
  it('拒绝重复前缀（后者会被永久遮蔽）', () => {
    expect(() => defineApiModules([
      module({ id: 'a', prefix: '/api/security' }),
      module({ id: 'b', prefix: '/api/security' }),
    ])).toThrow(/Duplicate API prefix/);
  });

  it('拒绝重复 id 与非法前缀', () => {
    expect(() => defineApiModules([
      module({ id: 'dup', prefix: '/api/a' }),
      module({ id: 'dup', prefix: '/api/b' }),
    ])).toThrow(/Duplicate API module id/);
    expect(() => defineApiModules([module({ id: 'bad', prefix: '/api' })])).toThrow(/Invalid API prefix/);
    expect(() => defineApiModules([module({ id: 'bad2', prefix: '/api/a/' })])).toThrow(/Invalid API prefix/);
  });

  it('要求 description，并校验 closedStateProbes 归属', () => {
    expect(() => defineApiModules([module({ id: 'nodesc', prefix: '/api/x', description: '  ' })]))
      .toThrow(/requires a description/);
    expect(() => defineApiModules([
      module({ id: 'probe', prefix: '/api/init', closedStateProbes: ['/api/other/status'] }),
    ])).toThrow(/must live under/);
  });

  it('豁免前缀由模块声明派生，不再手写第二份清单', () => {
    const modules = defineApiModules([
      module({ id: 'init', prefix: '/api/init', exemptFromInitGate: true }),
      module({ id: 'users', prefix: '/api/users' }),
    ]);
    expect(getExemptPrefixes(modules)).toEqual(['/api/init']);
    expect(toManifest(modules).find((m) => m.id === 'init')?.exemptFromInitGate).toBe(true);
  });

  it('静态子路径晚于父前缀注册时只提示不抛错', () => {
    expect(() => defineApiModules([
      module({ id: 'domains', prefix: '/api/domains' }),
      module({ id: 'templates', prefix: '/api/domains/email-templates' }),
    ])).not.toThrow();
  });

  it('前缀唯一性按归一化比较：大小写与参数名不影响判定', () => {
    expect(() => defineApiModules([
      module({ id: 'a', prefix: '/api/logs' }),
      module({ id: 'b', prefix: '/api/Logs' }),
    ])).toThrow(/Duplicate API prefix/);
    expect(() => defineApiModules([
      module({ id: 'c', prefix: '/api/domains/:domainId/records' }),
      module({ id: 'd', prefix: '/api/domains/:id/records' }),
    ])).toThrow(/Duplicate API prefix/);
  });
});

describe('init gate', () => {
  const modules = defineApiModules([
    module({ id: 'init', prefix: '/api/init', exemptFromInitGate: true, closedStateProbes: ['/api/init/status'] }),
    module({ id: 'users', prefix: '/api/users' }),
  ]);

  it('已初始化：全部放行', () => {
    const gate = createInitGate(modules, { isInitialized: () => true, isSurfaceOpen: () => false });
    expect(runGate(gate, '/api/users').nextCalled).toBe(true);
    expect(runGate(gate, '/api/anything').nextCalled).toBe(true);
  });

  it('未初始化且数据库可达：仅豁免模块放行，其余 503 needsInit', () => {
    const gate = createInitGate(modules, { isInitialized: () => false, isSurfaceOpen: () => true });
    expect(runGate(gate, '/api/init/status').nextCalled).toBe(true);
    const blocked = runGate(gate, '/api/users');
    expect(blocked.nextCalled).toBe(false);
    expect(blocked.res.statusCode).toBe(503);
    expect((blocked.res.body as { data: { needsInit: boolean } }).data.needsInit).toBe(true);
  });

  it('数据库不可达：初始化面一并关闭，只放行显式声明的只读探测', () => {
    const gate = createInitGate(modules, { isInitialized: () => false, isSurfaceOpen: () => false });
    expect(runGate(gate, '/api/init/status').nextCalled).toBe(true);
    const blocked = runGate(gate, '/api/init/database');
    expect(blocked.nextCalled).toBe(false);
    expect(blocked.res.statusCode).toBe(503);
    expect((blocked.res.body as { data: { needsInit: boolean; dbReachable: boolean } }).data)
      .toEqual({ needsInit: false, dbReachable: false });
  });

  it('数据库不可达时，只读探测也必须是读方法', () => {
    const gate = createInitGate(modules, { isInitialized: () => false, isSurfaceOpen: () => false });
    expect(runGate(gate, '/api/init/status', 'GET').nextCalled).toBe(true);
    expect(runGate(gate, '/api/init/status', 'HEAD').nextCalled).toBe(true);
    expect(runGate(gate, '/api/init/status', 'POST').nextCalled).toBe(false);
  });

  it('大小写不敏感：/API/USERS 不能绕过门禁', () => {
    const gate = createInitGate(modules, { isInitialized: () => false, isSurfaceOpen: () => true });
    expect(runGate(gate, '/API/USERS').nextCalled).toBe(false);
  });

  it('非 /api 路径不受门禁约束（SPA 与静态资源）', () => {
    const gate = createInitGate(modules, { isInitialized: () => false, isSurfaceOpen: () => false });
    expect(runGate(gate, '/setup').nextCalled).toBe(true);
    expect(runGate(gate, '/assets/index.js').nextCalled).toBe(true);
  });
});

describe('service 门禁接线（allowed_services）', () => {
  it('DNS 数据面模块声明 service=dns，MCP 声明 service=mcp，认证类不声明', () => {
    const manifest = toManifest(buildApiModules());
    const byId = new Map(manifest.map((item) => [item.id, item.service]));
    expect(byId.get('records')).toBe('dns');
    expect(byId.get('domains')).toBe('dns');
    expect(byId.get('providers')).toBe('dns');
    expect(byId.get('accounts')).toBe('dns');
    expect(byId.get('mcp')).toBe('mcp');
    expect(byId.get('auth')).toBeNull();
    expect(byId.get('tokens')).toBeNull();
  });
});
