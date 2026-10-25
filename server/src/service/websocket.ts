/**
 * WebSocket Service
 * 提供实时推送功能，跟随 HTTP 协议
 */

import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import jwt from 'jsonwebtoken';
import { verifyToken } from './token';
import { createLogger } from '../lib/logger';
import { getClientIP } from '../middleware/clientIP';
import { JwtPayload } from '../types';
import { TokenPayload } from '../types/token';
import { getJwtSecret } from './jwt';

const log = createLogger('Websocket');

interface WSClient {
  ws: WebSocket;
  userId: number;
  role: string;
  isAlive: boolean;
  // Rate limiting
  messageCount: number; // Messages in current window
  lastMessageTime: number; // Timestamp of last message
  rateLimitWindow: number; // Window start time
}

class WSService {
  private wss: WebSocketServer | null = null;
  /**
   * 连接表：key = `${userId}#${seq}`。
   *
   * 同一用户允许多条连接（多标签页/多设备）。此前按 userId 单键存储，
   * 新连接注册时会把旧连接 close 掉，两个标签页互相踢、指示器每秒闪断，
   * 且被踢的那个标签页从此收不到任何事件（只能靠手动刷新）。
   */
  private clients: Map<string, WSClient> = new Map();
  private connectionSeq = 0;
  /** 单用户最大连接数：多页签/多设备够用，同时挡住「一个账号开上千条连接」的资源放大 */
  private static readonly MAX_CONNECTIONS_PER_USER = 10;
  /** 用户 → 连接 key 集合：让 socketsOf 从 O(全表) 降到 O(该用户的连接数) */
  private readonly userIndex: Map<number, Set<string>> = new Map();

  /** 某用户当前的所有连接 */
  private socketsOf(userId: number): WSClient[] {
    const keys = this.userIndex.get(userId);
    if (!keys || keys.size === 0) return [];
    const out: WSClient[] = [];
    for (const key of keys) {
      const client = this.clients.get(key);
      if (client) out.push(client);
    }
    return out;
  }

  private track(key: string, client: WSClient): void {
    this.clients.set(key, client);
    const set = this.userIndex.get(client.userId) ?? new Set<string>();
    set.add(key);
    this.userIndex.set(client.userId, set);
  }

  private untrack(key: string): void {
    const client = this.clients.get(key);
    this.clients.delete(key);
    if (!client) return;
    const set = this.userIndex.get(client.userId);
    if (!set) return;
    set.delete(key);
    if (set.size === 0) this.userIndex.delete(client.userId);
  }
  private heartbeatInterval: NodeJS.Timeout | null = null;

  /**
   * 初始化 WebSocket 服务器
   */
  initialize(server: any): void {
    this.wss = new WebSocketServer({
      server,
      path: '/api/socket/ws',
      maxPayload: 1024 * 1024, // 1MB
    });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    this.wss.on('error', (error: Error) => {
      log.error('WebSocket server error', { error: error.message });
    });

    // 启动心跳检测
    this.startHeartbeat();

    log.info('WebSocket server initialized on /api/socket/ws');
  }

  /**
   * 处理 WebSocket 连接
   */
  private async handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    // 使用 getClientIP 获取真实客户端 IP（支持反向代理）
    const clientIp = getClientIP(req as any);
    log.info('New WebSocket connection attempt', { ip: clientIp });

    try {
      // 从 URL 参数或 Cookie 中获取 token
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const token = url.searchParams.get('token') ||
                    req.headers.cookie?.match(/token=([^;]+)/)?.[1];

      if (!token) {
        log.warn('WebSocket connection rejected: no token', { ip: clientIp });
        ws.close(4001, 'Authentication required');
        return;
      }

      let userId: number;
      let role: string;
      let authType: 'jwt' | 'api';

      // 首先尝试验证为 JWT
      try {
        const jwtSecret = await getJwtSecret();
        const payload = jwt.verify(token, jwtSecret) as JwtPayload;
        userId = payload.userId;
        role = String(payload.role);
        authType = 'jwt';
        log.info('JWT authentication successful', { userId, role, ip: clientIp });
      } catch (jwtError) {
        // JWT 验证失败，尝试验证为 API Token
        const tokenPayload = await verifyToken(token);
        if (!tokenPayload) {
          log.warn('WebSocket connection rejected: invalid token', { ip: clientIp });
          ws.close(4002, 'Invalid token');
          return;
        }
        userId = tokenPayload.userId;
        role = String(tokenPayload.maxRole);
        authType = 'api';
        log.info('API token authentication successful', { userId, role, ip: clientIp });
      }

      // 注册新客户端（同一用户允许多条连接，但要有上限）
      if (this.socketsOf(userId).length >= WSService.MAX_CONNECTIONS_PER_USER) {
        log.warn('Too many connections for user, rejecting new socket', { userId });
        ws.close(4005, 'Too many connections');
        return;
      }
      const client: WSClient = {
        ws,
        userId,
        role,
        isAlive: true,
        messageCount: 0,
        lastMessageTime: Date.now(),
        rateLimitWindow: Date.now(),
      };

      this.track(`${userId}#${++this.connectionSeq}`, client);

      log.info('WebSocket client connected', {
        userId,
        role,
        authType,
        totalClients: this.clients.size
      });

      // 发送欢迎消息
      this.sendToClient(userId, {
        type: 'connected',
        data: { message: 'WebSocket connected successfully', authType },
      });

      // 处理消息
      ws.on('message', (data: string) => {
        this.handleMessage(client, data.toString());
      });

      // 处理断开连接
      ws.on('close', () => {
        this.handleDisconnect(userId, ws);
      });

      // 处理错误
      ws.on('error', (error: Error) => {
        log.error('WebSocket client error', {
          userId,
          error: error.message
        });
        this.handleDisconnect(userId, ws);
      });

      // 心跳响应
      ws.on('pong', () => {
        // 直接闭包引用本连接：不必为了改一个布尔值去遍历全部连接
        client.isAlive = true;
      });

    } catch (error) {
      log.error('WebSocket connection error', {
        error: error instanceof Error ? error.message : String(error)
      });
      ws.close(4003, 'Internal server error');
    }
  }

  /**
   * 处理客户端消息
   */
  private handleMessage(client: WSClient, message: string): void {
    if (!client) return;
    const userId = client.userId;

    // Rate limiting: max 10 messages per second
    const now = Date.now();
    const RATE_LIMIT_WINDOW = 1000; // 1 second window
    const MAX_MESSAGES_PER_WINDOW = 10;

    // Reset window if expired
    if (now - client.rateLimitWindow > RATE_LIMIT_WINDOW) {
      client.messageCount = 0;
      client.rateLimitWindow = now;
    }

    // Check rate limit
    client.messageCount++;
    if (client.messageCount > MAX_MESSAGES_PER_WINDOW) {
      log.warn('Rate limit exceeded, closing connection', {
        userId,
        messageCount: client.messageCount
      });
      client.ws.close(4004, 'Rate limit exceeded');
      return;
    }

    client.lastMessageTime = now;

    try {
      const data = JSON.parse(message);
      log.debug('Received message from client', { userId, type: data.type });

      // Limit message size to 64KB
      if (message.length > 64 * 1024) {
        log.warn('Message too large', { userId, size: message.length });
        this.sendToClient(userId, {
          type: 'error',
          data: { message: 'Message too large (max 64KB)' }
        });
        return;
      }

      // 可以根据消息类型处理不同的请求
      switch (data.type) {
        case 'ping':
          this.sendToClient(userId, { type: 'pong' });
          break;
        default:
          log.warn('Unknown message type', { userId, type: data.type });
      }
    } catch (error) {
      log.error('Failed to parse message', {
        userId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * 处理客户端断开连接
   */
  /**
   * 断开处理。
   *
   * 必须带上 socket 做身份校验：同用户重连时我们先 close 旧连接、再注册新连接，
   * 而旧连接的 close 事件是**异步**落地的——不校验身份就会把刚注册的新连接删掉，
   * 新连接虽然 OPEN，但再也收不到 pong/广播（clientCount 归零还会让资源采集停摆）。
   */
  private handleDisconnect(userId: number, ws?: WebSocket): void {
    // 按 socket 身份精确删除：同一用户可能有多条连接，删错会把别人的连接一起带走
    let removed = false;
    for (const [key, client] of this.clients) {
      if (client.userId !== userId) continue;
      if (ws && client.ws !== ws) continue;
      this.untrack(key);
      removed = true;
      break;
    }
    if (!removed) return;
    log.info('WebSocket client disconnected', { userId, totalClients: this.clients.size });
  }

  /**
   * 启动心跳检测（每 30 秒）
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.clients.forEach((client, key) => {
        if (!client.isAlive) {
          log.warn('Client failed heartbeat, disconnecting', { userId: client.userId });
          client.ws.terminate();
          this.untrack(key);
          return;
        }

        client.isAlive = false;
        client.ws.ping();
      });
    }, 30000);
  }

  /**
   * 向指定用户发送消息
   */
  /**
   * 发给指定用户的**所有**在线连接（多标签页/多设备都会收到）。
   * 名字沿用历史叫法，语义是「按用户投递」，不是「按单个 socket」。
   */
  sendToClient(userId: number, message: any): boolean {
    const data = JSON.stringify(message);
    let sent = false;
    for (const client of this.socketsOf(userId)) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      try {
        client.ws.send(data);
        sent = true;
      } catch (error) {
        log.error('Failed to send message to client', {
          userId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return sent;
  }

  /**
   * 向所有在线用户广播消息
   */
  /** 当前在线连接数（用于让周期任务在无人订阅时跳过采集/广播） */
  get clientCount(): number {
    return this.clients.size;
  }

  broadcast(message: any): void {
    // 没有连接时直接返回：既省一次 JSON.stringify，也避免把「无人接收」当成已送达
    if (this.clients.size === 0) return;
    const data = JSON.stringify(message);
    this.clients.forEach((client) => {
      if (client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(data);
        } catch (error) {
          log.error('Failed to broadcast to client', {
            userId: client.userId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    });
  }

  /**
   * 定向广播：只发给指定用户集合，返回实际投递人数。
   *
   * 为什么需要它：`broadcast` 会把消息推给所有在线用户，带域名标识的事件
   * （如 `domain_whois_updated`）一旦走全局广播，就等于把他人域名与到期时间
   * 推给每一个已连接客户端。收件人必须由调用方按「能读到该资源的用户」算出，
   * 本方法只负责投递与去重。
   */
  broadcastToUsers(userIds: Iterable<number>, message: any): number {
    const data = JSON.stringify(message);
    const seen = new Set<number>();
    let delivered = 0;

    for (const raw of userIds) {
      const userId = Number(raw);
      // 去重：同一用户既是账号创建者又是授权用户时不能收到两遍
      if (!Number.isFinite(userId) || seen.has(userId)) continue;
      seen.add(userId);

      const sockets = this.socketsOf(userId);
      if (sockets.length === 0) continue;
      let any = false;
      for (const client of sockets) {
        if (client.ws.readyState !== WebSocket.OPEN) continue;
        try {
          client.ws.send(data);
          any = true;
        } catch (error) {
          log.error('Failed to send message to users', {
            userId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (any) delivered += 1;
    }

    return delivered;
  }

  /**
   * 向指定角色的用户广播消息
   */
  broadcastToRole(role: string, message: any): void {
    const data = JSON.stringify(message);
    this.clients.forEach((client) => {
      if (client.role === role && client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(data);
        } catch (error) {
          log.error('Failed to broadcast to role', {
            userId: client.userId,
            role,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    });
  }

  /**
   * 向指定用户发送消息
   */
  sendToUser(userId: number, message: any): void {
    this.sendToClient(userId, message);
  }

  /**
   * 停止 WebSocket 服务
   */
  shutdown(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    this.clients.forEach((client) => {
      client.ws.close(1001, 'Server shutting down');
    });
    this.clients.clear();
    this.userIndex.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    log.info('WebSocket server shut down');
  }

  /**
   * 获取在线客户端数量
   */
  getClientCount(): number {
    return this.clients.size;
  }
}

// 导出单例
export const wsService = new WSService();
