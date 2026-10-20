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
  private clients: Map<number, WSClient> = new Map();
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

      // 如果已存在连接，关闭旧连接
      const existingClient = this.clients.get(userId);
      if (existingClient) {
        log.info('Closing existing WebSocket connection', { userId });
        existingClient.ws.close(4000, 'New connection established');
      }

      // 注册新客户端
      const client: WSClient = {
        ws,
        userId,
        role,
        isAlive: true,
        messageCount: 0,
        lastMessageTime: Date.now(),
        rateLimitWindow: Date.now(),
      };

      this.clients.set(userId, client);

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
        this.handleMessage(userId, data.toString());
      });

      // 处理断开连接
      ws.on('close', () => {
        this.handleDisconnect(userId);
      });

      // 处理错误
      ws.on('error', (error: Error) => {
        log.error('WebSocket client error', {
          userId,
          error: error.message
        });
        this.handleDisconnect(userId);
      });

      // 心跳响应
      ws.on('pong', () => {
        const client = this.clients.get(userId);
        if (client) {
          client.isAlive = true;
        }
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
  private handleMessage(userId: number, message: string): void {
    const client = this.clients.get(userId);
    if (!client) return;

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
  private handleDisconnect(userId: number): void {
    const client = this.clients.get(userId);
    if (client) {
      this.clients.delete(userId);
      log.info('WebSocket client disconnected', {
        userId,
        totalClients: this.clients.size
      });
    }
  }

  /**
   * 启动心跳检测（每 30 秒）
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.clients.forEach((client, userId) => {
        if (!client.isAlive) {
          log.warn('Client failed heartbeat, disconnecting', { userId });
          client.ws.terminate();
          this.clients.delete(userId);
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
  sendToClient(userId: number, message: any): boolean {
    const client = this.clients.get(userId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      client.ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      log.error('Failed to send message to client', {
        userId,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  /**
   * 向所有在线用户广播消息
   */
  broadcast(message: any): void {
    const data = JSON.stringify(message);
    this.clients.forEach((client, userId) => {
      if (client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(data);
        } catch (error) {
          log.error('Failed to broadcast to client', {
            userId,
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

      const client = this.clients.get(userId);
      if (!client || client.ws.readyState !== WebSocket.OPEN) continue;

      try {
        client.ws.send(data);
        delivered += 1;
      } catch (error) {
        log.error('Failed to send message to users', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return delivered;
  }

  /**
   * 向指定角色的用户广播消息
   */
  broadcastToRole(role: string, message: any): void {
    const data = JSON.stringify(message);
    this.clients.forEach((client, userId) => {
      if (client.role === role && client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(data);
        } catch (error) {
          log.error('Failed to broadcast to role', {
            userId,
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
    const client = this.clients.get(userId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      try {
        const data = JSON.stringify(message);
        client.ws.send(data);
      } catch (error) {
        log.error('Failed to send message to user', {
          userId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  /**
   * 停止 WebSocket 服务
   */
  shutdown(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    this.clients.forEach((client, userId) => {
      client.ws.close(1001, 'Server shutting down');
    });
    this.clients.clear();

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
