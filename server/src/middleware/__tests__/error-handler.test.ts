import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { errorHandler } from '../errorHandler';

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.body = payload; return res; },
  };
  return res;
}

function run(err: unknown) {
  const res = fakeRes();
  errorHandler(err as Error, { path: '/api/x', method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as Request, res as unknown as Response, (() => {}) as NextFunction);
  return res;
}

describe('errorHandler', () => {
  it('畸形 JSON → 400 而不是 500', () => {
    const err = Object.assign(new SyntaxError('Unexpected token'), { type: 'entity.parse.failed', status: 400 });
    const res = run(err);
    expect(res.statusCode).toBe(400);
    expect((res.body as { msg: string }).msg).toMatch(/Invalid JSON/);
  });

  it('超限请求体仍返回 413', () => {
    const res = run(Object.assign(new Error('too large'), { type: 'entity.too.large' }));
    expect(res.statusCode).toBe(413);
  });
});
