import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http, { Server } from 'http';
import { AddressInfo } from 'net';

/**
 * 回归目标：用户管理事件不得再走全局广播。
 *
 * 现象：创建/更新/删除三处都用 wsService.broadcast 推送 user_* 事件，payload 带
 * 用户名与角色，全局广播等于把「系统里有哪些账号、谁是管理员」公开给所有在线客户端，
 * 而 HTTP 上 GET /users 是 adminOnly（role >= admin）。
 *
 * 口径依据：本文件三条路由都挂了 adminOnly，读接口 GET /users 同样是 adminOnly，
 * 因此收件人 = 全部 admin + 超管。
 */
const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  broadcastToUsers: vi.fn(),
  user: { userId: 100, role: 3 },
  target: { id: 300, username: 'member1', role: 1, role_level: 1, status: 1 } as Record<string, unknown>,
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = mocks.user;
    next();
  },
  // adminOnly 的判定由 auth.ts 负责，这里只放行；权限用例单独改 mocks.user 模拟被拒
  adminOnly: (req: any, res: any, next: any) => {
    const level = Number(req.user?.role ?? 0);
    if (level < 2) {
      res.status(403).json({ code: -1, msg: 'Admin access required' });
      return;
    }
    next();
  },
  noTokenAuth: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../db/bal/business-adapter', () => ({
  UserOperations: {
    getAll: vi.fn(async () => [
      { id: 1, role_level: 3, status: 1 },
      { id: 100, role_level: 3, status: 1 },
      { id: 200, role_level: 2, status: 1 },
      { id: 300, role_level: 1, status: 1 },
    ]),
    getById: vi.fn(async () => mocks.target),
    create: vi.fn(async () => 300),
    update: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  },
}));
vi.mock('../service/websocket', () => ({
  wsService: { broadcast: mocks.broadcast, broadcastToUsers: mocks.broadcastToUsers },
}));

import usersRouter from './users';

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
  app.use('/api/users', usersRouter);
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
  mocks.user = { userId: 100, role: 3 };
  mocks.target = { id: 300, username: 'member1', role: 1, role_level: 1, status: 1 };
});

describe('用户管理事件的推送范围', () => {
  it('新建用户只推给管理员，不再全局广播', async () => {
    const res = await call('POST', '/api/users', {
      username: 'member1',
      password: 'Passw0rdX',
      email: 'm1@example.com',
      role: 1,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { code: number }).code).toBe(0);

    // admin 100 / 200 + 超管 1；普通用户 300 不在收件人里
    expect(audiences()).toEqual([[1, 100, 200]]);
    expect(mocks.broadcastToUsers).toHaveBeenCalledWith(
      [1, 100, 200],
      expect.objectContaining({
        type: 'user_created',
        data: expect.objectContaining({ userId: 300, username: 'member1', role: 'member' }),
      }),
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('更新用户只推给管理员，不再全局广播', async () => {
    const res = await call('PUT', '/api/users/300', { nickname: 'member-one' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { code: number }).code).toBe(0);

    expect(audiences()).toEqual([[1, 100, 200]]);
    expect(mocks.broadcastToUsers).toHaveBeenCalledWith(
      [1, 100, 200],
      expect.objectContaining({
        type: 'user_updated',
        data: expect.objectContaining({ userId: 300, username: 'member1' }),
      }),
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('删除用户只推给管理员，不再全局广播', async () => {
    const res = await call('DELETE', '/api/users/300');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { code: number }).code).toBe(0);

    expect(audiences()).toEqual([[1, 100, 200]]);
    expect(mocks.broadcastToUsers).toHaveBeenCalledWith(
      [1, 100, 200],
      expect.objectContaining({
        type: 'user_deleted',
        data: expect.objectContaining({ userId: 300, username: 'member1' }),
      }),
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('非管理员被拒且不推送', async () => {
    mocks.user = { userId: 300, role: 1 };

    const res = await call('PUT', '/api/users/300', { nickname: 'x' });
    expect(res.status).toBe(403);

    expect(mocks.broadcastToUsers).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });
});
