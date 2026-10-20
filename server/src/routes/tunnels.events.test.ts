import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http, { Server } from 'http';
import { AddressInfo } from 'net';

/**
 * 回归目标：隧道事件不得再走全局广播。
 *
 * 现象：改隧道配置与删除隧道两处都用 wsService.broadcast 推送 tunnel_* 事件，
 * payload 带 Cloudflare 账号 ID 与隧道 ID，全局广播等于把「谁有哪条隧道」推给所有
 * 在线客户端。
 *
 * 口径依据：本文件读路径 GET /tunnels 与 GET /:accountId/:tunnelId 都先用
 * getAccessibleCloudflareAccounts() 过滤（super 取全部；否则 created_by 或所属团队），
 * 因此收件人 = 超管 + 账号创建者 + 团队成员。
 */
const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  broadcastToUsers: vi.fn(),
  user: { userId: 100, role: 1 },
  account: {
    id: 5,
    type: 'cloudflare',
    name: 'cf-main',
    config: JSON.stringify({ accountId: 'cf-acc', apiToken: 'fixture-token' }),
    created_by: 100,
    team_id: 9 as number | null,
  },
  accessible: true,
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = mocks.user;
    next();
  },
}));
vi.mock('../lib/dns/providers', () => ({
  CloudflareAdapter: class {
    async getTunnels() {
      return [];
    }
    async getTunnelConfig() {
      return { config: {} };
    }
    async updateTunnelConfig() {
      return true;
    }
    async deleteTunnel() {
      return true;
    }
  },
}));
vi.mock('../db/bal/business-adapter', () => ({
  DnsAccountOperations: {
    getByType: vi.fn(async () => (mocks.accessible ? [mocks.account] : [])),
    getByTypeAndUser: vi.fn(async () => (mocks.accessible ? [mocks.account] : [])),
    getByTypeAndUserOrTeams: vi.fn(async () => (mocks.accessible ? [mocks.account] : [])),
  },
  TeamOperations: {
    getTeamIdsByUserId: vi.fn(async () => [9]),
    getMembers: vi.fn(async () => [{ user_id: 300 }, { user_id: 301 }]),
  },
  UserOperations: {
    getAll: vi.fn(async () => [
      { id: 1, role_level: 3, status: 1 },
      { id: 100, role_level: 1, status: 1 },
      { id: 300, role_level: 1, status: 1 },
      { id: 301, role_level: 1, status: 1 },
      { id: 400, role_level: 1, status: 1 },
    ]),
  },
}));
vi.mock('../service/websocket', () => ({
  wsService: { broadcast: mocks.broadcast, broadcastToUsers: mocks.broadcastToUsers },
}));

import tunnelsRouter from './tunnels';
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
  app.use('/api/tunnels', tunnelsRouter);
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
  mocks.accessible = true;
});

describe('隧道事件的推送范围', () => {
  it('修改隧道配置只推给能读到该账号的用户，不再全局广播', async () => {
    const res = await call('PUT', '/api/tunnels/cf-acc/tun-1/config', { config: { ingress: [] } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { code: number }).code).toBe(0);

    // 超管 1 + 账号创建者 100 + 团队成员 300/301；无关用户 400 不在其中
    expect(audiences()).toEqual([[1, 100, 300, 301]]);
    expect(mocks.broadcastToUsers).toHaveBeenCalledWith(
      [1, 100, 300, 301],
      expect.objectContaining({
        type: 'tunnel_config_updated',
        data: { accountId: 'cf-acc', tunnelId: 'tun-1' },
      }),
    );
    // 回归闸门：隧道标识不得再推给所有人
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('删除隧道只推给能读到该账号的用户，不再全局广播', async () => {
    const res = await call('DELETE', '/api/tunnels/cf-acc/tun-1');
    expect(res.status).toBe(200);

    expect(audiences()).toEqual([[1, 100, 300, 301]]);
    expect(mocks.broadcastToUsers).toHaveBeenCalledWith(
      [1, 100, 300, 301],
      expect.objectContaining({
        type: 'tunnel_deleted',
        data: { accountId: 'cf-acc', tunnelId: 'tun-1' },
      }),
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('账号不在可访问列表时 404 且不推送', async () => {
    mocks.accessible = false;

    const res = await call('DELETE', '/api/tunnels/cf-acc/tun-1');
    expect(res.status).toBe(404);

    expect(mocks.broadcastToUsers).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });
});
