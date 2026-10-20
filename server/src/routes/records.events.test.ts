import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http, { Server } from 'http';
import { AddressInfo } from 'net';

/**
 * 回归目标：记录类事件不得再走全局广播。
 *
 * 现象：POST/PUT/DELETE/PUT-status 四个记录接口都用 wsService.broadcast 推送
 * record_* 事件，payload 里带 domainId / recordId / host / 记录值，所有在线客户端
 * 都能收到，等于把他人域名的解析结构与记录内容推给了不该看见的人。
 * 口径：与同文件读接口 GET /domains/:domainId/records 的 canRead 一致，
 * 由 getDomainAudienceUserIds 落实，因此这里跑的是真实实现（不 mock realtime-audience）。
 */
const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  broadcastToUsers: vi.fn(),
  /** 当前请求的用户（角色 2 = admin，作为账号创建者拥有读写权限） */
  user: { userId: 100, role: 2 },
  access: {
    domain: { id: 11, name: 'a.com', account_id: 5 },
    canRead: true,
    canWrite: true,
    writeSubs: null as string[] | null,
    hasRules: false,
  },
  adapter: {
    addDomainRecord: vi.fn(async () => 'rec-1'),
    getDomainRecordInfo: vi.fn(async () => ({
      RecordId: 'rec-1',
      Domain: 'a.com',
      Name: 'www',
      Type: 'A',
      Value: '1.2.3.4',
      Line: '0',
      TTL: 600,
      MX: 0,
      Status: 1,
    })),
    updateDomainRecord: vi.fn(async () => true),
    deleteDomainRecord: vi.fn(async () => true),
    setDomainRecordStatus: vi.fn(async () => true),
  },
  // 以下是真实 realtime-audience 实现所依赖的底层操作
  getDomainById: vi.fn(),
  getAccountById: vi.fn(),
  hasRules: vi.fn(),
  getByDomainId: vi.fn(),
  getMembers: vi.fn(),
  getAllUsers: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = mocks.user;
    next();
  },
  requireTokenDomainPermission: () => (_req: any, _res: any, next: any) => next(),
}));
// 读权限判定在路由里由 getDomainAccess 完成，这里直接给出结论
vi.mock('./domains', () => ({
  getDomainAccess: vi.fn(async () => mocks.access),
}));
vi.mock('../db/bal/business-adapter', () => ({
  DomainOperations: {
    updateRecordCount: vi.fn(async () => undefined),
    getById: mocks.getDomainById,
  },
  DnsAccountOperations: { getById: mocks.getAccountById },
  DomainPermissionOperations: {
    hasRules: mocks.hasRules,
    getByDomainId: mocks.getByDomainId,
  },
  TeamOperations: { getMembers: mocks.getMembers },
  UserOperations: { getAll: mocks.getAllUsers },
}));
vi.mock('../lib/dns/DnsHelper', () => ({ createAdapter: () => mocks.adapter }));
// 记录类型能力表与本次断言无关，返回空表即可放行
vi.mock('../lib/dns/providers/registry', () => ({ getProviderDefinitions: () => [] }));
vi.mock('../service/audit', () => ({ logAuditOperation: vi.fn() }));
vi.mock('../workflow/publish', () => ({
  hasWorkflowSubscribers: () => false,
  publishRecordEvent: vi.fn(),
}));
vi.mock('../service/websocket', () => ({
  wsService: { broadcast: mocks.broadcast, broadcastToUsers: mocks.broadcastToUsers },
}));

import recordsRouter from './records';
import { resetRealtimeAudienceCache } from '../service/realtime-audience';

let server: Server;

/** 取「收件人集合 + 事件类型」，排序后比较，避免依赖集合内部的插入顺序 */
function pushed(): Array<{ audience: number[]; type: string }> {
  return mocks.broadcastToUsers.mock.calls.map((call) => ({
    audience: [...(call[0] as number[])].sort((a, b) => a - b),
    type: (call[1] as { type: string }).type,
  }));
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/domains/:domainId/records', recordsRouter);
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
  for (const fn of [
    mocks.getDomainById,
    mocks.getAccountById,
    mocks.hasRules,
    mocks.getByDomainId,
    mocks.getMembers,
    mocks.getAllUsers,
  ]) {
    fn.mockReset();
  }

  mocks.user = { userId: 100, role: 2 };
  mocks.access = {
    domain: { id: 11, name: 'a.com', account_id: 5 },
    canRead: true,
    canWrite: true,
    writeSubs: null,
    hasRules: false,
  };

  // 域名 11 属于账号 5，账号由 admin 100 创建 → 可读集合 = {100} + 超管 {1}
  mocks.getDomainById.mockResolvedValue({ id: 11, account_id: 5 });
  mocks.getAccountById.mockResolvedValue({
    id: 5,
    type: 'cloudflare',
    config: '{}',
    created_by: 100,
    enabled: 1,
  });
  mocks.hasRules.mockResolvedValue(false);
  mocks.getByDomainId.mockResolvedValue([]);
  mocks.getMembers.mockResolvedValue([]);
  mocks.getAllUsers.mockResolvedValue([
    { id: 1, role_level: 3, status: 1 },
    { id: 100, role_level: 2, status: 1 },
    { id: 200, role_level: 2, status: 1 },
  ]);
});

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

describe('解析记录事件的推送范围', () => {
  it('新增记录只推给能读到该域名的用户，不再全局广播', async () => {
    const res = await call('POST', '/api/domains/11/records', {
      name: 'www',
      type: 'A',
      value: '1.2.3.4',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { code: number }).code).toBe(0);

    expect(pushed()).toEqual([{ audience: [1, 100], type: 'record_created' }]);
    // payload 结构不变：仍带 recordId / domainId / host / type / record
    expect(mocks.broadcastToUsers).toHaveBeenCalledWith(
      [100, 1],
      expect.objectContaining({
        type: 'record_created',
        data: expect.objectContaining({
          recordId: 'rec-1',
          domainId: 11,
          host: 'www',
          type: 'A',
        }),
      }),
    );
    // 回归闸门：带域名标识的 payload 不得再走全局广播
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('更新记录只推给能读到该域名的用户，不再全局广播', async () => {
    const res = await call('PUT', '/api/domains/11/records/rec-1', {
      name: 'www',
      type: 'A',
      value: '1.2.3.5',
    });
    expect(res.status).toBe(200);

    expect(pushed()).toEqual([{ audience: [1, 100], type: 'record_updated' }]);
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('删除记录只推给能读到该域名的用户，不再全局广播', async () => {
    const res = await call('DELETE', '/api/domains/11/records/rec-1');
    expect(res.status).toBe(200);

    expect(pushed()).toEqual([{ audience: [1, 100], type: 'record_deleted' }]);
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('启停记录只推给能读到该域名的用户，不再全局广播', async () => {
    const res = await call('PUT', '/api/domains/11/records/rec-1/status', { status: 0 });
    expect(res.status).toBe(200);

    expect(pushed()).toEqual([{ audience: [1, 100], type: 'record_status_changed' }]);
    expect(mocks.broadcastToUsers).toHaveBeenCalledWith(
      [100, 1],
      expect.objectContaining({
        type: 'record_status_changed',
        data: expect.objectContaining({ recordId: 'rec-1', domainId: 11, status: 0 }),
      }),
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('域名账号被禁用时收件人为空：跳过投递且不回退成全局广播', async () => {
    mocks.getAccountById.mockResolvedValue({
      id: 5,
      type: 'cloudflare',
      config: '{}',
      created_by: 100,
      enabled: 0,
    });

    const res = await call('PUT', '/api/domains/11/records/rec-1', {
      name: 'www',
      type: 'A',
      value: '1.2.3.5',
    });
    expect(res.status).toBe(200);

    // fail-closed：不推给任何人，尤其不能退化成全员广播
    expect(mocks.broadcastToUsers).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });
});
