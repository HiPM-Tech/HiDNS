import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { AppError, errorHandler } from '../../middleware/errorHandler';

/**
 * 响应契约守护（code === HTTP 状态、统一 {code,data,msg}）。
 *
 * docs/api.md 是 API 语义的第一权威：`code` 与 HTTP 状态一致，响应体恒为 {code,data,msg}。
 * 历史违反点集中在 routes/tunnels、routes/auth/profile 与 middleware/auth，已逐条修掉；
 * 这条用例把约定钉死，避免再次漂移：
 *   1) 扫描 routes/ 与 middleware/ 源码，出现 `code: -1` 即失败；
 *   2) 直接调用 errorHandler，断言 4xx/5xx 都是信封形状（不再返回 {code,message,...}）。
 */
const SRC = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['routes', 'middleware', 'api'];

/**
 * 协议性端点：响应体由外部标准规定，不能套项目信封。
 * - mcp-oauth：OAuth 2.0 / OIDC 的 { error, error_description }
 * - mcp-config：MCP 的 .well-known 发现文档
 * - rdap：RDAP 标准 JSON
 */
const PROTOCOL_ALLOWLIST = new Set(['mcp-oauth.ts', 'rdap.ts']);

/**
 * mcp-config.ts 里既有 MCP 发现文档（`/.well-known/*`，协议形状）又有普通信封端点，
 * 所以不能整文件豁免——只放过块前 600 字符内出现 `.well-known` 的那些响应。
 */
/**
 * 端点级豁免：找块前**最近一次** `router.<method>('<path>'` 声明，判断该响应是否属于
 * `/.well-known/*` 路由。此前用「向前 2000 字符是否出现 .well-known」的启发式，
 * 同一文件里紧随其后的普通端点会被一并放过。
 */
function isWellKnownBlock(src: string, index: number): boolean {
  const before = src.slice(0, index);
  const matches = [...before.matchAll(/router\.(?:get|post|put|patch|delete|route)\(\s*'([^']+)'/g)];
  const last = matches[matches.length - 1];
  return last ? last[1].includes('.well-known') : false;
}

function scannedFiles(): string[] {
  const out: string[] = [];
  for (const dir of SCAN_DIRS) {
    const base = path.join(SRC, dir);
    const walk = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.name === '__tests__') continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) out.push(full);
      }
    };
    walk(base);
  }
  return out;
}

/** 最小 res 桩：只记录 status 与 body */
function fakeRes(): Response & { statusCode?: number; body?: unknown } {
  const res = {
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode?: number; body?: unknown };
}

function runHandler(err: Error): { statusCode?: number; body?: { code?: number; msg?: string; data?: unknown } } {
  const res = fakeRes();
  const req = { path: '/x', method: 'GET', headers: {}, ip: '203.0.113.1', socket: { remoteAddress: '203.0.113.1' } } as unknown as Request;
  errorHandler(err, req, res, () => undefined);
  return { statusCode: res.statusCode, body: res.body as { code?: number; msg?: string; data?: unknown } };
}

describe('响应契约', () => {
  it('routes/ 与 middleware/ 不出现 code:-1', () => {
    const offenders: string[] = [];
    for (const file of scannedFiles()) {
      if (PROTOCOL_ALLOWLIST.has(path.basename(file))) continue;
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if (/code:\s*-1\b/.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('*')) {
          offenders.push(path.relative(SRC, file) + ':' + (index + 1) + ' → ' + line.trim());
        }
      });
    }
    expect(offenders).toEqual([]);
  });


  it('res.status(N) 的 code 必须等于 N（信封与状态码一致）', () => {
    const offenders: string[] = [];
    for (const file of scannedFiles()) {
      const src = fs.readFileSync(file, 'utf8');
      const re = /res\.status\((\d{3})\)\s*\.json\(\{([\s\S]{0,400}?)\}\)/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(src))) {
        const status = Number(match[1]);
        if (PROTOCOL_ALLOWLIST.has(path.basename(file))) continue;
        if (isWellKnownBlock(src, match.index)) continue;
        const body = match[2];
        const line = src.slice(0, match.index).split('\n').length;
        const codeMatch = body.match(/code:\s*(-?\d+)/);
        if (!codeMatch) {
          offenders.push(path.relative(SRC, file) + ':' + line + ' 缺少 code 字段');
          continue;
        }
        const code = Number(codeMatch[1]);
        if (code !== status) {
          offenders.push(path.relative(SRC, file) + ':' + line + ' status=' + status + ' code=' + code);
        }
        if (!/msg:/.test(body)) {
          offenders.push(path.relative(SRC, file) + ':' + line + ' 缺少 msg 字段');
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('不带状态码的 res.json 也不得返回 {success}/{error}/{message} 形状（含多行）', () => {
    const offenders: string[] = [];
    for (const file of scannedFiles()) {
      if (PROTOCOL_ALLOWLIST.has(path.basename(file))) continue;
      const src = fs.readFileSync(file, 'utf8');
      for (const match of src.matchAll(/res\.(?:json|send)\(\{([\s\S]{0,240}?)\}\)/g)) {
        const body = match[1];
        if (isWellKnownBlock(src, match.index)) continue;
        if (/code:\s*-?\d/.test(body)) continue;
        if (!/(success|error|message)\s*:/.test(body)) continue;
        const line = src.slice(0, match.index).split('\n').length;
        offenders.push(path.relative(SRC, file) + ':' + line + ' → 裸响应（缺 code）: ' + body.trim().slice(0, 60));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('协议豁免文件里的响应必须是协议形状（防止借豁免夹带普通信封漂移）', () => {
    const offenders: string[] = [];
    for (const file of scannedFiles()) {
      if (!PROTOCOL_ALLOWLIST.has(path.basename(file))) continue;
      const src = fs.readFileSync(file, 'utf8');
      for (const match of src.matchAll(/res\.status\((\d{3})\)\s*\.json\(\{([\s\S]{0,300}?)\}\)/g)) {
        const body = match[2];
        // 普通信封（有 code）由上面的用例管；这里只约束「非信封」的那些块必须是协议形状
        if (/code:\s*\d+/.test(body)) continue;
        // RFC 6749/7591/7009/7662 定义的形状：错误、重定向、令牌、DCR 注册响应、
        // introspect 的 { active }、revoke 的空对象 {} 都算协议形状
        const isProtocolShape = /error|redirect_url|access_token|refresh_token|token_type|scope|active|client_secret|client_id_issued_at|objectClassName|issuer/.test(body)
          || body.trim() === '';
        if (!isProtocolShape) {
          const line = src.slice(0, match.index).split('\n').length;
          offenders.push(path.relative(SRC, file) + ':' + line + ' 非协议形状且未走信封');
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('sendError 即使没有 data 也保留 data 键（值为 null）', async () => {
    const { sendError } = await import('../../utils/http');
    const res = fakeRes();
    sendError(res, 'boom', 400);
    expect((res.body as { data?: unknown }).data).toBeNull();
  });

  it('AppError 走统一信封，且 code 与 HTTP 状态一致', () => {
    const { statusCode, body } = runHandler(new AppError(403, 'Admin access required'));
    expect(statusCode).toBe(403);
    expect(body).toMatchObject({ code: 403, msg: 'Admin access required' });
    expect(body).not.toHaveProperty('message');
    expect(body).toHaveProperty('data');
  });

  it('未知异常兜底为 500 信封', () => {
    const { statusCode, body } = runHandler(new Error('boom'));
    expect(statusCode).toBe(500);
    expect(body).toMatchObject({ code: 500 });
    expect(typeof body?.msg).toBe('string');
    expect(body).not.toHaveProperty('message');
  });

  it('ValidationError 映射到 400 信封，细节放在 data 里', () => {
    const err = new Error('name is required');
    err.name = 'ValidationError';
    const { statusCode, body } = runHandler(err);
    expect(statusCode).toBe(400);
    expect(body).toMatchObject({ code: 400, msg: 'Validation failed' });
    expect(body?.data).toEqual({ error: 'name is required' });
  });

  it('JsonWebTokenError 映射到 401 信封', () => {
    const err = new Error('invalid signature');
    err.name = 'JsonWebTokenError';
    const { statusCode, body } = runHandler(err);
    expect(statusCode).toBe(401);
    expect(body).toMatchObject({ code: 401, msg: 'Invalid token' });
  });

  it('JWT 错误映射到 401 信封', () => {
    const expired = new Error('jwt expired');
    expired.name = 'TokenExpiredError';
    const { statusCode, body } = runHandler(expired);
    expect(statusCode).toBe(401);
    expect(body).toMatchObject({ code: 401, msg: 'Token expired' });
  });
});
