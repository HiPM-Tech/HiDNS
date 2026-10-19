import { describe, it, expect } from 'vitest';
import { authorize } from '../../auth';
import type { AuthorizeDeps, Principal } from '../../auth';
import { varWorkflowHandlers } from '../var/workflow';

const deps: AuthorizeDeps = {
  lookupAction: () => ({
    name: 'var.workflow.get',
    actionClass: 'http',
    service: 'system.read',
    dslVisible: true,
  }),
  audit: async () => undefined,
  rateLimit: () => true,
  now: () => 1_700_000_000_000,
  newTraceId: () => 'trace-var',
};

const principal: Principal = {
  kind: 'user',
  id: 'u1',
  role: 'user',
  services: ['system.read'],
  allowedDomains: '*',
  allowedWriteDomainIds: [],
};

describe('var.workflow.get', () => {
  it('只能读到本次运行注入的变量', async () => {
    const ctx = await authorize('var.workflow.get', principal, undefined, deps, { vars: { ip: '1.2.3.4' } });
    const handler = varWorkflowHandlers['var.workflow.get'];
    await expect(handler(ctx, { key: 'ip' })).resolves.toBe('1.2.3.4');
    await expect(handler(ctx, { key: 'password' })).resolves.toBeNull();
  });

  it('未注入变量时返回 null，且不泄漏原型链属性', async () => {
    const ctx = await authorize('var.workflow.get', principal, undefined, deps);
    const handler = varWorkflowHandlers['var.workflow.get'];
    await expect(handler(ctx, { key: 'constructor' })).resolves.toBeNull();
    await expect(handler(ctx, { key: '__proto__' })).resolves.toBeNull();
  });
});