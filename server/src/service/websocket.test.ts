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

type FakeClient = ReturnType<typeof fakeClient>;
const service = wsService as unknown as {
  clients: Map<string, FakeClient>;
  userIndex: Map<number, Set<string>>;
};

/** 按当前连接表结构注入：clients 以 `userId#seq` 为键，userIndex 维护 用户→键 集合 */
function install(clients: FakeClient[], index: Map<number, Set<string>> = new Map()) {
  const map = new Map<string, FakeClient>();
  clients.forEach((client, position) => {
    const key = `${client.userId}#${position}`;
    map.set(key, client);
    const set = index.get(client.userId) ?? new Set<string>();
    set.add(key);
    index.set(client.userId, set);
  });
  service.clients = map;
  service.userIndex = index;
}

beforeEach(() => {
  service.clients = new Map();
  service.userIndex = new Map();
});

afterEach(() => {
  service.clients = new Map();
  service.userIndex = new Map();
});

describe('broadcastToUsers', () => {
  it('只发给指定用户集合，其它在线用户收不到', () => {
    const mine = fakeClient(42);
    const other = fakeClient(43);
    install([mine, other]);

    const delivered = wsService.broadcastToUsers([42], { type: 'domain_whois_updated' });

    expect(delivered).toBe(1);
    expect(mine.ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'domain_whois_updated' }));
    expect(other.ws.send).not.toHaveBeenCalled();
  });

  it('同一用户重复出现只投递一次（创建者与授权用户可能是同一人）', () => {
    const client = fakeClient(42);
    install([client]);

    const delivered = wsService.broadcastToUsers([42, 42, Number('42')], { type: 'x' });

    expect(delivered).toBe(1);
    expect(client.ws.send).toHaveBeenCalledTimes(1);
  });

  it('跳过未连接与非 OPEN 的客户端，非法 id 直接忽略', () => {
    const open = fakeClient(1);
    const closing = fakeClient(2, 2);
    install([open, closing]);

    const delivered = wsService.broadcastToUsers([1, 2, 3, Number.NaN, 0, -1], { type: 'x' });

    expect(delivered).toBe(1);
    expect(open.ws.send).toHaveBeenCalledTimes(1);
    expect(closing.ws.send).not.toHaveBeenCalled();
  });

  it('空集合不投递任何人', () => {
    const client = fakeClient(42);
    install([client]);

    expect(wsService.broadcastToUsers([], { type: 'x' })).toBe(0);
    expect(client.ws.send).not.toHaveBeenCalled();
  });
});

describe('多连接索引', () => {
  const internals = wsService as unknown as {
    clients: Map<string, FakeClient>;
    userIndex: Map<number, Set<string>>;
    track: (key: string, client: FakeClient) => void;
    untrack: (key: string) => void;
    socketsOf: (userId: number) => FakeClient[];
  };

  it('track 后可按用户取到全部连接，untrack 只删指定连接', () => {
    const a = fakeClient(42);
    const b = fakeClient(42);
    internals.track('42#1', a);
    internals.track('42#2', b);
    expect(internals.socketsOf(42)).toHaveLength(2);

    internals.untrack('42#1');
    expect(internals.socketsOf(42)).toHaveLength(1);
  });

  it('最后一条连接断开后清掉 userIndex 键，避免索引泄漏', () => {
    const only = fakeClient(7);
    internals.track('7#1', only);
    expect(internals.userIndex.has(7)).toBe(true);
    internals.untrack('7#1');
    expect(internals.userIndex.has(7)).toBe(false);
    expect(internals.clients.size).toBe(0);
  });
});
