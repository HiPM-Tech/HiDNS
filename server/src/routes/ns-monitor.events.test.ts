import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http, { Server } from 'http';
import { AddressInfo } from 'net';

/**
 * 回归目标：NS 监测事件不得再走全局广播。
 *
 * 现象：prefs / create / update / delete 四处都用 wsService.broadcast 推送
 * ns_monitor_* 事件，payload 里带 userId、monitorId、domainName 与整条配置。
 * 全局广播等于把「某个用户正在监测哪些域名、期望的 NS 是什么」推给所有在线客户端。
 *
 * 口径依据（同文件 HTTP 读接口）：
 *   - GET /ns-monitor            → NSMonitorOperations.getUserMonitorsWithPagination(userId, ...)
 *   - GET /ns-monitor/:id        → NSMonitorOperations.getById(id, userId)（带 user_id 过滤）
 *   - GET /ns-monitor/user/prefs → NSMonitorOperations.getUserPrefs(userId)
 * 三者都只返回「本人」的数据，所以收件人 = 请求者本人（多端登录仍能同步）。
 */
const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  broadcastToUsers: vi.fn(),
  user: { userId: 100, role: 1 },
  monitors: new Map<number, Record<string, unknown>>(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = mocks.user;
    next();
  },
}));
vi.mock('./domains', () => ({
  getDomainAccess: vi.fn(async () => ({ domain: { id: 11 }, canRead: true, canWrite: true })),
}));
vi.mock('../lib/dns/ns-lookup', () => ({
  resolveNsRecords: vi.fn(async () => ({ nsRecords: ['ns1.a.com'], encryptedResult: null, plainResult: null, isPoisoned: false })),
  validateNsRecords: vi.fn(() => ({ valid: true })),
}));
vi.mock('../db/bal/business-adapter', () => ({
  getDbType: () => 'mysql',
  formatDateForDB: (v: unknown) => v,
  DomainOperations: {
    getByName: vi.fn(async () => ({ id: 11, name: 'a.com' })),
  },
  NSMonitorOperations: {
    getUserPrefs: vi.fn(async () => ({ user_id: 100, notify_email: 1 })),
    updateUserPrefs: vi.fn(async () => undefined),
    createUserPrefs: vi.fn(async () => 1),
    getUserMonitorsWithPagination: vi.fn(async () => ({ list: [], total: 0 })),
    // 关键口径：带 userId 时只返回本人的配置，与 HTTP 读接口一致
    getById: vi.fn(async (id: number, userId?: number) => {
      const monitor = mocks.monitors.get(id);
      if (!monitor) return undefined;
      return userId === undefined || monitor.user_id === userId ? monitor : undefined;
    }),
    getByDomainName: vi.fn(async () => undefined),
    create: vi.fn(async () => 1),
    update: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  },
}));
vi.mock('../service/websocket', () => ({
  wsService: { broadcast: mocks.broadcast, broadcastToUsers: mocks.broadcastToUsers },
}));

import nsMonitorRouter from './ns-monitor';

let server: Server;

/** 收件人集合（排序后比较，避免依赖集合插入顺序） */
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
  app.use('/api/ns-monitor', nsMonitorRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  mocks.broadcast.mockReset();
  mocks.broadcastToUsers.mockReset();
  mocks.broadcastToUsers.mockReturnValue(1);
  mocks.user = { userId: 100, role: 1 };
  mocks.monitors.clear();
  mocks.monitors.set(1, { id: 1, user_id: 100, domain_name: 'a.com', expected_ns: 'ns1.a.com' });
});

describe('NS 监测事件的推送范围', () => {
  it('偏好设置变更只推给本人，不再全局广播', async () => {
    const res = await call('PUT', '/api/ns-monitor/user/prefs', { check_interval: 1800 });
    expect(res.status).toBe(200);

    expect(audiences()).toEqual([[100]]);
    expect(mocks.broadcastToUsers).toHaveBeenCalledWith(
      [100],
      expect.objectContaining({
        type: 'ns_monitor_prefs_updated',
        data: expect.objectContaining({ userId: 100 }),
      }),
    );
    // 回归闸门：别人不该收到「谁改了监测偏好」
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('新建监测配置只推给创建者，不再全局广播', async () => {
    const res = await call('POST', '/api/ns-monitor', { domain_name: 'a.com' });
    expect(res.status).toBe(200);

    expect(audiences()).toEqual([[100]]);
    expect(mocks.broadcastToUsers).toHaveBeenCalledWith(
      [100],
      expect.objectContaining({
        type: 'ns_monitor_created',
        data: expect.objectContaining({ userId: 100, domainName: 'a.com' }),
      }),
    );
    // payload 里带整条配置（含期望 NS），绝不能进全局广播
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('更新监测配置只推给配置所属用户，不再全局广播', async () => {
    const res = await call('PUT', '/api/ns-monitor/1', { expected_ns: 'ns2.a.com' });
    expect(res.status).toBe(200);

    expect(audiences()).toEqual([[100]]);
    expect(mocks.broadcastToUsers).toHaveBeenCalledWith(
      [100],
      expect.objectContaining({
        type: 'ns_monitor_updated',
        data: expect.objectContaining({ monitorId: 1, userId: 100 }),
      }),
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('删除监测配置只推给配置所属用户，不再全局广播', async () => {
    const res = await call('DELETE', '/api/ns-monitor/1');
    expect(res.status).toBe(200);

    expect(audiences()).toEqual([[100]]);
    expect(mocks.broadcastToUsers).toHaveBeenCalledWith(
      [100],
      expect.objectContaining({
        type: 'ns_monitor_deleted',
        data: expect.objectContaining({ monitorId: 1, userId: 100 }),
      }),
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('他人的监测配置：404 且一次都不推送', async () => {
    mocks.user = { userId: 200, role: 1 };

    const res = await call('DELETE', '/api/ns-monitor/1');
    expect(res.status).toBe(404);

    expect(mocks.broadcastToUsers).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });
});
