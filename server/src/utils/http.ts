import { Request, Response } from 'express';
import { ApiResponse } from '../types';

type IntegerOptions = {
  defaultValue?: number;
  min?: number;
  max?: number;
};

function getFirstValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

export function getString(value: unknown): string | undefined {
  const normalized = getFirstValue(value);
  if (typeof normalized !== 'string') {
    return undefined;
  }

  const trimmed = normalized.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseInteger(value: unknown, options: IntegerOptions = {}): number | undefined {
  const normalized = getFirstValue(value);

  if (normalized === undefined || normalized === null || normalized === '') {
    return options.defaultValue;
  }

  const parsed = typeof normalized === 'number'
    ? normalized
    : Number.parseInt(String(normalized), 10);

  if (!Number.isInteger(parsed)) {
    return options.defaultValue;
  }

  let result = parsed;

  if (options.min !== undefined) {
    result = Math.max(options.min, result);
  }

  if (options.max !== undefined) {
    result = Math.min(options.max, result);
  }

  return result;
}

export function parsePagination(
  query: Request['query'],
  options: { defaultPage?: number; defaultPageSize?: number; maxPageSize?: number } = {}
): { page: number; pageSize: number } {
  const page = parseInteger(query.page, {
    defaultValue: options.defaultPage ?? 1,
    min: 1,
  }) ?? 1;
  const pageSize = parseInteger(query.pageSize, {
    defaultValue: options.defaultPageSize ?? 50,
    min: 1,
    max: options.maxPageSize ?? 200,
  }) ?? (options.defaultPageSize ?? 50);

  return { page, pageSize };
}

export function sendSuccess<T>(res: Response, data?: T, msg = 'success', statusCode = 200): Response {
  return res.status(statusCode).json({
    code: 0,
    data: data ?? null,
    msg,
  } as ApiResponse<T>);
}

/**
 * 统一错误响应。
 *
 * 语义约束（docs/refactor/00-PLAN.md §3）：`code` 必须与 HTTP 状态码一致，
 * 默认 400（客户端错误）；权限拒绝显式 403、资源不存在 404、冲突 409、服务端异常 500。
 * 历史默认 200 让 120+ 处错误路径"成功返回"，已废弃。
 */
export function sendError(res: Response, msg: string, statusCode = 400, data?: unknown): Response {
  const status = statusCode >= 400 ? statusCode : 400;
  return res.status(status).json({
    code: status,
    // 统一补 null：否则信封里整个 data 键会消失，前端/外部适配器读到 undefined
    data: data ?? null,
    msg,
  } as ApiResponse);
}

export function sendServerError(res: Response, msg = 'Database error'): Response {
  return sendError(res, msg, 500);
}
