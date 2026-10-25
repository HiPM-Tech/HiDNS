import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';
import { getRequestIP } from './clientIP';

/** 统一限流响应：必须是信封 + JSON，否则前端只看到一段 HTML 文本 */
function rateLimitHandler(message: string) {
  return (req: Request, res: Response) => {
    res.status(429).json({ code: 429, data: null, msg: message });
  };
}

/**
 * 登录速率限制 - 防止暴力破解
 * 默认：15 分钟内最多 5 个失败尝试
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 分钟
  max: 5, // 限制登录尝试次数
  handler: rateLimitHandler('Too many login attempts, please try again later.'),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    // 使用 username/IP 组合作为 key，防止用户名枚举绕过
    const identifier = req.body?.username || req.body?.email || 'unknown';
    // 用真实 TCP 对端地址：TRUST_PROXY=true 时 req.ip / XFF 可伪造，等于限流可绕过
    const ip = req.socket?.remoteAddress || getRequestIP(req) || 'unknown';
    return `${identifier.toLowerCase()}:${ip}`;
  },
});

/**
 * 邮件发送速率限制 - 防止邮件轰炸
 * 默认：1 小时内最多 5 封邮件
 */
export const emailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 小时
  max: 5, // 限制邮件发送次数
  handler: rateLimitHandler('Too many emails sent, please try again later.'),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    // 使用邮箱地址作为 key
    return (req.body?.email || getRequestIP(req) || 'unknown').toLowerCase();
  },
});

/**
 * API 端点速率限制 - 防止特定端点被滥用
 * 默认：1 分钟内最多 30 个请求
 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 分钟
  max: 120, // 限制请求数
  handler: rateLimitHandler('Too many requests to this endpoint, please try again later.'),
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * 严格的 API 端点速率限制 - 用于敏感操作
 * 默认：1 分钟内最多 30 个请求（比 apiLimiter 更严格）
 */
export const strictApiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 分钟
  max: 30, // 限制请求数（更严格）
  handler: rateLimitHandler('Too many requests to this endpoint, please try again later.'),
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * 自定义速率限制器工厂函数
 * @param windowMs 时间窗口（毫秒）
 * @param max 最大请求数
 * @param message 错误消息
 */
export function createLimiter(
  windowMs: number,
  max: number,
  message: string = 'Too many requests, please try again later.'
) {
  return rateLimit({
    windowMs,
    max,
    handler: rateLimitHandler(message),
    standardHeaders: true,
    legacyHeaders: false,
  });
}

/**
 * RDAP 公开查询速率限制
 * - 未认证（公开 IP）：2 请求/秒
 * - 已认证（携带 Cookie 或 API Token）：不限速
 */
export const rdapLimiter = rateLimit({
  windowMs: 1000,
  max: 2,
  handler: rateLimitHandler('Too many RDAP queries, please try again later.'),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req: Request) => {
    // 仅会话登录用户跳过限速；任意 Bearer 不再免限（此前伪造 Bearer 即可绕过）
    return !!(req as any).cookies?.token;
  },
});

/**
 * 基于用户 ID 的速率限制器
 * 用于已认证的用户
 */
export function createUserLimiter(windowMs: number, max: number) {
  return rateLimit({
    windowMs,
    max,
    handler: rateLimitHandler('Too many requests, please try again later.'),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => {
      // 使用用户 ID 作为 key（需要在 auth 中间件后使用）
      return (req as any).user?.id?.toString() || getRequestIP(req) || 'unknown';
    },
  });
}
