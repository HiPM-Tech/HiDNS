import { Request, Response, NextFunction } from 'express';
import { createLogger } from '../lib/logger';
import { getRequestIP } from './clientIP';
import { sendError } from '../utils/http';

const log = createLogger('HTTP').sub('Middleware').sub('ErrorHandler');

/**
 * 自定义 API 错误：携带 HTTP 状态码与可选的结构化细节。
 *
 * 响应形状统一由 sendError 决定（{code,data,msg} 且 code === HTTP 状态），
 * 不再使用历史上的 {code,message,details,timestamp}——前端只读 msg，
 * 旧形状会让未捕获错误在界面上退化成「HTTP 500」。
 */
export class AppError extends Error {
  constructor(
    public code: number,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** 全局错误处理：把任意异常收敛成统一信封 */
export function errorHandler(
  err: Error | AppError,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  log.error(`Request error: ${err.message}`, {
    name: err.name,
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    ip: getRequestIP(req),
  });

  if (err instanceof AppError) {
    sendError(res, err.message, err.code, err.details ?? null);
    return;
  }

  // body-parser 的超限错误：默认会走 500，前端只看到「Internal server error」
  const bodyParserType = (err as Error & { type?: string }).type;
  if (bodyParserType === 'entity.too.large') {
    sendError(res, 'Request body too large', 413);
    return;
  }
  if (bodyParserType === 'entity.parse.failed') {
    sendError(res, 'Invalid JSON body', 400);
    return;
  }

  if (err.name === 'ValidationError') {
    sendError(res, 'Validation failed', 400, { error: err.message });
    return;
  }

  if (err.name === 'JsonWebTokenError') {
    sendError(res, 'Invalid token', 401);
    return;
  }

  if (err.name === 'TokenExpiredError') {
    sendError(res, 'Token expired', 401);
    return;
  }

  // 兜底：生产不回显内部错误文本，开发环境透出便于定位
  sendError(res, process.env.NODE_ENV === 'development' ? err.message : 'Internal server error', 500);
}

/**
 * Async route wrapper to catch errors
 * Usage: router.get('/path', asyncHandler(async (req, res) => { ... }))
 */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
