import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { resolveWebAuthnConfig } from '../webauthn';

function fakeReq(host: string, headers: Record<string, string> = {}, protocol = 'http'): Request {
  return { headers, protocol, get: (name: string) => (name.toLowerCase() === 'host' ? host : undefined) } as unknown as Request;
}

describe('resolveWebAuthnConfig', () => {
  it('按请求 Host/协议推导 RP ID 与 Origin（不再固定 localhost:3000）', () => {
    const cfg = resolveWebAuthnConfig(fakeReq('dns.example.com', {}, 'https'));
    expect(cfg).toEqual({ rpID: 'dns.example.com', origin: 'https://dns.example.com' });
  });

  it('反向代理场景使用 X-Forwarded-*', () => {
    const cfg = resolveWebAuthnConfig(fakeReq('127.0.0.1:3001', { 'x-forwarded-host': 'dns.example.com', 'x-forwarded-proto': 'https' }));
    expect(cfg).toEqual({ rpID: 'dns.example.com', origin: 'https://dns.example.com' });
  });

  it('带端口时 RP ID 去掉端口，Origin 保留', () => {
    const cfg = resolveWebAuthnConfig(fakeReq('localhost:5173'));
    expect(cfg).toEqual({ rpID: 'localhost', origin: 'http://localhost:5173' });
  });
});
