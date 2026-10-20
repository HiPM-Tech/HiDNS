import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { wsService } from './websocket';

/**
 * `clients` 是私有状态，这里按测试需要直接注入假客户端：
 * 定向广播的语义（去重、跳过离线、返回投递数）不值得为了可测性改生产结构。
 */
function fakeClient(userId: number, readyState = 1) {
  return {
    ws: { readyState, send: vi.fn(), close: vi.fn(), ping: vi.fn(), terminate: vi.fn() },
    userId,
    role: '1',
    isAlive: true,
    messageCount: 0,
    lastMessageTime: 0,
    rateLimitWindow: 0,
  };
}

const service = wsService as unknown as { clients: Map<number, unknown> };

beforeEach(() => {
  service.clients = new Map();
});

afterEach(() => {
  service.clients = new Map();
});

describe('broadcastToUsers', () => {
  it('只发给指定用户集合，其它在线用户收不到', () => {
    const mine = fakeClient(42);
    const other = fakeClient(43);
    service.clients = new Map([
      [42, mine],
      [43, other],
    ]);

    const delivered = wsService.broadcastToUsers([42], { type: 'domain_whois_updated' });

    expect(delivered).toBe(1);
    expect(mine.ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'domain_whois_updated' }));
    expect(other.ws.send).not.toHaveBeenCalled();
  });

  it('同一用户重复出现只投递一次（创建者与授权用户可能是同一人）', () => {
    const client = fakeClient(42);
    service.clients = new Map([[42, client]]);

    const delivered = wsService.broadcastToUsers([42, 42, Number('42')], { type: 'x' });

    expect(delivered).toBe(1);
    expect(client.ws.send).toHaveBeenCalledTimes(1);
  });

  it('跳过未连接与非 OPEN 的客户端，非法 id 直接忽略', () => {
    const open = fakeClient(1);
    const closing = fakeClient(2, 2);
    service.clients = new Map([
      [1, open],
      [2, closing],
    ]);

    const delivered = wsService.broadcastToUsers([1, 2, 3, Number.NaN, 0, -1], { type: 'x' });

    expect(delivered).toBe(1);
    expect(open.ws.send).toHaveBeenCalledTimes(1);
    expect(closing.ws.send).not.toHaveBeenCalled();
  });

  it('空集合不投递任何人', () => {
    const client = fakeClient(42);
    service.clients = new Map([[42, client]]);

    expect(wsService.broadcastToUsers([], { type: 'x' })).toBe(0);
    expect(client.ws.send).not.toHaveBeenCalled();
  });
});
