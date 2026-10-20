import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http, { Server } from 'http';
import { AddressInfo } from 'net';

/**
 * 回归目标：团队事件不得再走全局广播。
 *
 * 现象：创建/更新/删除/加成员/移除成员五处都用 wsService.broadcast 推送 team_* 事件，
 * payload 带团队名与成员 ID，全局广播等于把「谁和谁在同一个团队、团队有哪些成员」
 * 推给所有在线客户端。
 *
 * 口径依据（本文件读接口）：
 *   GET /teams            → super 看全部，其他人 getByUserId
 *   GET /teams/:id        → isSuper(role) || isMember(teamId, userId)
 *   GET /teams/:id/members→ 同上
 * 因此收件人 = 团队成员 ∪ 超管。
 */
const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  broadcastToUsers: vi.fn(),
  user: { userId: 100, role: 2 },
  team: { id: 9, name: 'core', description: '', created_by: 100 },
  members: [] as Array<{ user_id: number }>,
  teamDeleted: false,
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = mocks.user;
    next();
  },
}));
vi.mock('../workflow/access', () => ({ invalidateAccessCache: vi.fn() }));
vi.mock('../service/audit', () => ({ logAuditOperation: vi.fn(async () => undefined) }));
vi.mock('../db/bal/business-adapter', () => ({
  TeamOperations: {
    getById: vi.fn(async () => (mocks.teamDeleted ? undefined : mocks.team)),
    create: vi.fn(async () => 9),
    update: vi.fn(async () => undefined),
    delete: vi.fn(async () => {
      mocks.teamDeleted = true;
    }),
    // 团队删除后成员查询结果为空，用来验证收件人确实是「删之前」算的
    getMembers: vi.fn(async () => (mocks.teamDeleted ? [] : mocks.members)),
    getMemberWithRole: vi.fn(async () => ({ role: 'admin' })),
    isMember: vi.fn(async (_teamId: number, userId: number) =>
      mocks.members.some((m) => m.user_id === userId),
    ),
    addMember: vi.fn(async (_teamId: number, userId: number) => {
      if (!mocks.members.some((m) => m.user_id === userId)) mocks.members.push({ user_id: userId });
    }),
    removeMember: vi.fn(async (_teamId: number, userId: number) => {
      mocks.members = mocks.members.filter((m) => m.user_id !== userId);
    }),
    getByUserId: vi.fn(async () => []),
  },
  UserOperations: {
    getAll: vi.fn(async () => [
      { id: 1, role_level: 3, status: 1 },
      { id: 100, role_level: 2, status: 1 },
      { id: 300, role_level: 1, status: 1 },
      { id: 400, role_level: 1, status: 1 },
    ]),
    getById: vi.fn(async (id: number) => ({ id, username: `u${id}` })),
  },
  DomainPermissionOperations: {},
  DomainOperations: {},
  DnsAccountOperations: {},
}));
vi.mock('../service/websocket', () => ({
  wsService: { broadcast: mocks.broadcast, broadcastToUsers: mocks.broadcastToUsers },
}));

import teamsRouter from './teams';
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
  app.use('/api/teams', teamsRouter);
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
  mocks.user = { userId: 100, role: 2 };
  mocks.team = { id: 9, name: 'core', description: '', created_by: 100 };
  mocks.members = [{ user_id: 100 }, { user_id: 300 }];
  mocks.teamDeleted = false;
});

describe('团队事件的推送范围', () => {
  it('新建团队只推给团队成员与超管，不再全局广播', async () => {
    mocks.members = [];
    const res = await call('POST', '/api/teams', { name: 'core' });
    expect(res.status).toBe(200);

    // 创建者被 addMember 加进团队，因此收件人 = {100} ∪ {超管 1}
    expect(audiences()).toEqual([[1, 100]]);
    expect(mocks.broadcastToUsers).toHaveBeenCalledWith(
      [100, 1],
      expect.objectContaining({
        type: 'team_created',
        data: expect.objectContaining({ teamId: 9, name: 'core' }),
      }),
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('更新团队只推给团队成员与超管，不再全局广播', async () => {
    const res = await call('PUT', '/api/teams/9', { name: 'core2' });
    expect(res.status).toBe(200);

    expect(audiences()).toEqual([[1, 100, 300]]);
    expect(mocks.broadcastToUsers).toHaveBeenCalledWith(
      [100, 300, 1],
      expect.objectContaining({ type: 'team_updated', data: expect.objectContaining({ teamId: 9 }) }),
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('删除团队的收件人在删除之前算出，删除后仍能通知到原成员', async () => {
    const res = await call('DELETE', '/api/teams/9');
    expect(res.status).toBe(200);

    // 若收件人算在删除之后，getMembers 已返回空，这里只会剩超管
    expect(audiences()).toEqual([[1, 100, 300]]);
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('新增成员：新成员本人也能收到（此时已具备读权限）', async () => {
    const res = await call('POST', '/api/teams/9/members', { user_id: 400, role: 'member' });
    expect(res.status).toBe(200);

    expect(audiences()).toEqual([[1, 100, 300, 400]]);
    expect(mocks.broadcastToUsers).toHaveBeenCalledWith(
      [100, 300, 400, 1],
      expect.objectContaining({
        type: 'team_member_added',
        data: expect.objectContaining({ teamId: 9, userId: 400, role: 'member' }),
      }),
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('移除成员：按移除之前的成员集合投递，被移除者也能得知自己已离开', async () => {
    const res = await call('DELETE', '/api/teams/9/members/300');
    expect(res.status).toBe(200);

    expect(audiences()).toEqual([[1, 100, 300]]);
    expect(mocks.broadcastToUsers).toHaveBeenCalledWith(
      [100, 300, 1],
      expect.objectContaining({
        type: 'team_member_removed',
        data: expect.objectContaining({ teamId: 9, userId: 300 }),
      }),
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });
});
