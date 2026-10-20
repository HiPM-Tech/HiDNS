import { describe, it, expect, vi } from 'vitest';

/**
 * 工作流是**管理员专属**能力：非管理员不得管理、操作、展示。
 * 这不是"界面上藏起来"就够——路由必须逐个挂 adminOnly，否则知道 URL 就能用。
 *
 * 这里直接检查 Express 路由表，新增路由漏挂守卫会立刻失败。
 */

vi.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  // 保留函数名，路由表里才能被识别
  adminOnly: function adminOnly(_req: unknown, _res: unknown, next: () => void) {
    next();
  },
  requireJwtAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../db/bal/business-adapter', () => ({
  DomainOperations: { getById: vi.fn(), getUserAccessibleDomains: vi.fn(async () => []) },
  DnsAccountOperations: { getById: vi.fn() },
  WorkflowOperations: {},
}));

vi.mock('../../service/dns-provider-service', () => ({
  DnsProviderService: { getAdapter: vi.fn(), getAdapterByAccount: vi.fn() },
}));

vi.mock('../../workflow/store', () => ({
  WorkflowStoreError: class WorkflowStoreError extends Error {},
  createWorkflow: vi.fn(),
  getStoredById: vi.fn(),
  getWorkflowMetaById: vi.fn(),
  latestSampleEvent: vi.fn(),
  listByOwner: vi.fn(),
  listRuns: vi.fn(),
  removeWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
}));

vi.mock('../../workflow/validate-payload', () => ({ validatePayload: vi.fn() }));
vi.mock('../../lib/dns/providers/tencenteo/meta-source', () => ({}));
vi.mock('../../lib/dns/providers/virtual/meta-source', () => ({}));

import workflowsRouter from '../workflows';
import { adminOnly as mockedAdminOnly } from '../../middleware/auth';

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ name?: string; handle?: { name?: string } }>;
  };
}

describe('工作流路由的管理员守卫', () => {
  const layers = ((workflowsRouter as unknown as { stack?: RouteLayer[] }).stack ?? []).filter(
    (layer) => layer.route,
  );

  it('路由表非空（防止本测试因路由结构变化而空转）', () => {
    expect(layers.length).toBeGreaterThan(5);
  });

  it('每一条工作流路由都挂了 adminOnly', () => {
    const offenders: string[] = [];
    for (const layer of layers) {
      const route = layer.route!;
      const names = route.stack.map((item) => item.name ?? item.handle?.name ?? '');
      if (!names.includes('adminOnly')) {
        offenders.push(`${Object.keys(route.methods).join('|').toUpperCase()} ${route.path}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('守卫用的确实是管理员中间件，而不是同名的空壳', () => {
    const route = layers[0].route!;
    const handlers = route.stack.map((item) => item.handle ?? item);
    expect(handlers).toContain(mockedAdminOnly);
  });
});
