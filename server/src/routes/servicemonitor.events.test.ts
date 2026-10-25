import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http, { Server } from 'http';
import { AddressInfo } from 'net';

/**
 * 回归目标：服务监控事件不得再走全局广播。
 *
 * 现象：创建/更新/删除/手动检查四处都用 wsService.broadcast 推送 servicemonitor_*
 * 事件，payload 带监控名、类型与目标地址（被监控的域名或 URL），全局广播等于把
 * 「谁在监控什么」推给所有在线客户端。
 *
 * 口径依据：本文件 GET /servicemonitor/:id 的判定 —
 * monitor.userId === 请求者 || isSuper(role)，因此收件人 = 所有者 + 超管。
 */
const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  broadcastToUsers: vi.fn(),
  user: { userId: 100, role: 1 },
  monitor: { id: 5, userId: 100, name: 'ssl-a', type: 'ssl_certificate', target: 'a.com' },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = mocks.user;
    next();
  },
  // servicemonitor 现在复用 domains 路由的 getDomainAccess，间接引入这些中间件，mock 需补齐
  requireTokenDomainPermission: () => (_req: any, _res: any, next: any) => next(),
  noTokenAuth: () => (_req: any, _res: any, next: any) => next(),
  adminOnly: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../db/bal/business-adapter', () => ({
  DomainOperations: { getById: vi.fn(async () => ({ id: 11, created_by: 100, team_id: null })) },
  TeamOperations: { isMember: vi.fn(async () => false) },
  UserOperations: {
    getAll: vi.fn(async () => [
      { id: 1, role_level: 3, status: 1 },
      { id: 100, role_level: 1, status: 1 },
      { id: 200, role_level: 2, status: 1 },
    ]),
  },
}));
vi.mock('../service/serviceMonitor', () => ({
  getMonitors: vi.fn(async () => []),
  getMonitor: vi.fn(async () => mocks.monitor),
  getMonitorsWithPagination: vi.fn(async () => ({ monitors: [], total: 0 })),
  getMonitorsByParentId: vi.fn(async () => []),
  createMonitor: vi.fn(async () => 5),
  updateMonitor: vi.fn(async () => undefined),
  deleteMonitor: vi.fn(async () => undefined),
  performCheck: vi.fn(async () => ({ status: 'ok', responseTime: 12, error: null, resultData: {} })),
  runCheckAndUpdate: vi.fn(async () => undefined),
}));
vi.mock('../service/websocket', () => ({
  wsService: { broadcast: mocks.broadcast, broadcastToUsers: mocks.broadcastToUsers },
}));

import serviceMonitorRouter from './servicemonitor';
import { resetRealtimeAudienceCache } from '../service/realtime-audience';

let server: Server;

function audiences(): number[][] {
  return mocks.broadcastToUsers.mock.calls.map((call) =>
    [...(call[0] as number[])].sort((a, b) => a - b),
  );
}

function url(path: string): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(url(path), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/servicemonitor', serviceMonitorRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  resetRealtimeAudienceCache();
  mocks.broadcast.mockReset();
  mocks.broadcastToUsers.mockReset();
  mocks.broadcastToUsers.mockReturnValue(1);
  mocks.user = { userId: 100, role: 1 };
  mocks.monitor = { id: 5, userId: 100, name: 'ssl-a', type: 'ssl_certificate', target: 'a.com' };
});

describe('服务监控事件的推送范围', () => {
  it('新建监控只推给所有者与超管，不再全局广播', async () => {
    const res = await call('POST', '/api/servicemonitor', {
      name: 'ssl-a',
      type: 'ssl_certificate',
      target: 'a.com',
    });
    expect(res.status).toBe(200);

    expect(audiences()).toEqual([[1, 100]]);
    expect(mocks.broadcastToUsers).toHaveBeenCalledWith(
      [100, 1],
      expect.objectContaining({
        type: 'servicemonitor_created',
        data: expect.objectContaining({ id: 5, name: 'ssl-a', target: 'a.com', userId: 100 }),
      }),
    );
    // 回归闸门：被监控目标不能被推给所有人
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('更新监控只推给所有者与超管，不再全局广播', async () => {
    const res = await call('PUT', '/api/servicemonitor/5', { name: 'ssl-a2' });
    expect(res.status).toBe(200);

    expect(audiences()).toEqual([[1, 100]]);
    expect(mocks.broadcastToUsers).toHaveBeenCalledWith(
      [100, 1],
      expect.objectContaining({ type: 'servicemonitor_updated', data: expect.objectContaining({ id: 5 }) }),
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('删除监控只推给所有者与超管，不再全局广播', async () => {
    const res = await call('DELETE', '/api/servicemonitor/5');
    expect(res.status).toBe(200);

    expect(audiences()).toEqual([[1, 100]]);
    expect(mocks.broadcastToUsers).toHaveBeenCalledWith(
      [100, 1],
      expect.objectContaining({ type: 'servicemonitor_deleted', data: expect.objectContaining({ id: 5 }) }),
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('手动检查只推给所有者与超管，不再全局广播', async () => {
    const res = await call('POST', '/api/servicemonitor/5/check');
    expect(res.status).toBe(200);

    expect(audiences()).toEqual([[1, 100]]);
    expect(mocks.broadcastToUsers).toHaveBeenCalledWith(
      [100, 1],
      expect.objectContaining({
        type: 'servicemonitor_checked',
        data: expect.objectContaining({ id: 5, status: 'ok' }),
      }),
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('超管代改他人监控：收件人仍是「所有者 + 超管」，不是操作者', async () => {
    mocks.user = { userId: 1, role: 3 };

    const res = await call('PUT', '/api/servicemonitor/5', { name: 'ssl-a3' });
    expect(res.status).toBe(200);

    // 所有者 100 必须收到；另一个管理员 200 不在收件人里
    expect(audiences()).toEqual([[1, 100]]);
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('无权用户操作他人监控被拒且不推送', async () => {
    mocks.user = { userId: 200, role: 2 };

    const res = await call('DELETE', '/api/servicemonitor/5');
    expect(res.status).toBe(403);

    expect(mocks.broadcastToUsers).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });
});
