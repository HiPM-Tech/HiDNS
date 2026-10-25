import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ensureOk, http, requestRaw } from '../http';

function mockFetch(body: unknown, status = 200) {
  const spy = vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('lib/http 契约', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('标准端点：信封 code/data/msg 正常返回', async () => {
    mockFetch({ code: 0, data: { ok: true }, msg: 'success' });
    const envelope = await http.get<{ ok: boolean }>('/x');
    expect(envelope.data.ok).toBe(true);
  });

  it('标准端点：缺 code 的裸 JSON 直接抛错（而不是当成成功）', async () => {
    mockFetch({ redirect_url: 'https://example.com' });
    await expect(http.get('/x')).rejects.toBeInstanceOf(ApiError);
  });

  it('requestRaw：用于 OAuth 裸返回，成功与失败都能读', async () => {
    mockFetch({ redirect_url: 'https://example.com/cb?code=1' });
    const ok = await requestRaw<{ redirect_url: string }>('/mcp/oauth/authorize', { decision: 'approve' });
    expect(ok).toMatchObject({ ok: true, status: 200 });
    expect(ok.data?.redirect_url).toContain('code=1');

    mockFetch({ error: 'invalid_request', error_description: 'redirect_uri 未注册' }, 400);
    const bad = await requestRaw<{ error_description: string }>('/mcp/oauth/authorize', {});
    expect(bad.ok).toBe(false);
    expect(bad.data?.error_description).toBe('redirect_uri 未注册');
  });

  it('http.patch 存在并发 PATCH（令牌启停 / 续期开关依赖它）', async () => {
    const spy = mockFetch({ code: 0, data: null, msg: 'success' });
    await http.patch('/tokens/1/status', { enabled: false });
    expect(spy).toHaveBeenCalledTimes(1);
    const init = (spy.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe(JSON.stringify({ enabled: false }));
  });

  it('ensureOk：code 非 0 抛 ApiError（写接口的假成功防护）', () => {
    expect(() => ensureOk({ code: -1, data: null, msg: 'Nothing to update' })).toThrow(ApiError);
    expect(() => ensureOk({ code: 0, data: null, msg: 'success' })).not.toThrow();
  });
});
