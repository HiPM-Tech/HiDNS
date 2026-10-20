import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http, { Server } from 'http';
import { AddressInfo } from 'net';

/**
 * 回归目标：系统设置事件不得再走全局广播。
 *
 * 现象：安全配置 / SMTP / OAuth / Logto / 登录限制五处写接口都用
 * wsService.broadcast 推送 xxx_updated 事件，payload 带 updatedBy（改配置的
 * 管理员 userId）与时间戳，全局广播等于把「谁在什么时候改了安全策略」告知所有在线
 * 用户。而本文件所有读写接口都挂了 adminOnly。
 *
 * 口径依据：GET /settings/* 与 PUT /settings/* 均为 adminOnly（role >= admin），
 * 因此收件人 = 全部 admin + 超管。
 */
const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  broadcastToUsers: vi.fn(),
  user: { userId: 100, role: 3 },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = mocks.user;
    next();
  },
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
vi.mock('../service/loginLimit', () => ({
  getLoginLimitConfig: vi.fn(async () => ({ enabled: true, maxAttempts: 5, lockoutDuration: 15 })),
  updateLoginLimitConfig: vi.fn(async () => undefined),
  getLoginAttemptStats: vi.fn(async () => ({})),
  unlockAccount: vi.fn(async () => undefined),
}));
vi.mock('../service/smtp', () => ({
  getSmtpConfig: vi.fn(async () => ({ enabled: false })),
  updateSmtpConfig: vi.fn(async () => ({ enabled: true, host: 'smtp.example.com', port: 587 })),
  sendSmtpEmail: vi.fn(async () => undefined),
}));
vi.mock('../service/audit', () => ({ logAuditOperation: vi.fn(async () => undefined) }));
vi.mock('../workflow/index', () => ({
  getOutboundAllowlist: vi.fn(() => []),
  reloadOutboundPolicy: vi.fn(async () => undefined),
}));
vi.mock('../db/bal/business-adapter', () => ({
  SettingsOperations: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
  },
  NotificationOperations: {},
  AuditRuleOperations: {},
  DomainExpiryOperations: {
    saveNotification: vi.fn(async () => undefined),
    saveDays: vi.fn(async () => undefined),
  },
  UserOperations: {
    getAll: vi.fn(async () => [
      { id: 1, role_level: 3, status: 1 },
      { id: 100, role_level: 3, status: 1 },
      { id: 200, role_level: 2, status: 1 },
      { id: 300, role_level: 1, status: 1 },
    ]),
  },
}));
vi.mock('../service/websocket', () => ({
  wsService: { broadcast: mocks.broadcast, broadcastToUsers: mocks.broadcastToUsers },
}));

import settingsRouter from './settings';

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
  app.use('/api/settings', settingsRouter);
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
});

describe('系统设置事件的推送范围', () => {
  it.each([
    ['PUT', '/api/settings/security', { jwtViewEmailNotify: true, showDnsProviderSecrets: false }, 'security_config_updated'],
    ['PUT', '/api/settings/smtp', { enabled: true, host: 'smtp.example.com', port: 587 }, 'smtp_updated'],
    ['PUT', '/api/settings/oauth', { enabled: false, providerName: 'generic' }, 'oauth_updated'],
    ['PUT', '/api/settings/oauth/logto', { enabled: false, logtoDomain: 'https://logto.example.com' }, 'oauth_updated'],
    ['PUT', '/api/settings/login-limit', { enabled: true, maxAttempts: 5, lockoutDuration: 15 }, 'config_updated'],
  ] as const)('%s %s 只推给管理员，不再全局广播', async (method, path, body, eventType) => {
    const res = await call(method, path, body);
    expect(res.status).toBe(200);

    // 收件人 = admin 100 / 200 + 超管 1；普通用户 300 不在其中
    expect(audiences()).toEqual([[1, 100, 200]]);
    const event = mocks.broadcastToUsers.mock.calls[0][1];
    expect(event.type).toBe(eventType);
    expect(event.data.updatedBy).toBe(100);
    expect(typeof event.data.timestamp).toBe('string');
    // 回归闸门：配置变更不得再推给所有人
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('普通用户调用设置接口被拒且不推送', async () => {
    mocks.user = { userId: 300, role: 1 };

    const res = await call('PUT', '/api/settings/security', { jwtViewEmailNotify: false });
    expect(res.status).toBe(403);

    expect(mocks.broadcastToUsers).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });
});
