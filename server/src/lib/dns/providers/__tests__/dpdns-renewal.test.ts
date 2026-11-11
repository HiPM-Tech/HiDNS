import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureCsrfToken: vi.fn(),
  loginWithPasskey: vi.fn(),
  authenticatedRequest: vi.fn(),
}));

vi.mock('../dpdns_reverse/auth', () => ({
  DPDNS_BASE_URL: 'https://dashboard.digitalplat.org',
  ensureCsrfToken: mocks.ensureCsrfToken,
  loginWithPasskey: mocks.loginWithPasskey,
  authenticatedRequest: mocks.authenticatedRequest,
  send: mocks.authenticatedRequest,
  resolveSessionJar: () => new Map<string, string>(),
}));

import { renewFreeDomain } from '../dpdns_reverse/renewal';

function jsonResponse(body: unknown) {
  const res: any = { ok: true, status: 200, json: async () => body };
  res.clone = () => res;   // 生产代码用 response.clone() 保留可重读的 body
  return res as Response;
}

describe('renewFreeDomain 的 CSRF 自愈', () => {
  beforeEach(() => {
    mocks.ensureCsrfToken.mockReset().mockResolvedValue('T');
    mocks.loginWithPasskey.mockReset().mockResolvedValue(undefined);
    mocks.authenticatedRequest.mockReset();
  });

  it('上游返回 Invalid CSRF token 时换签并重试一次', async () => {
    mocks.authenticatedRequest
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: 'Invalid CSRF token' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));   // 续期成功
    // getDomainInfo 的响应（拿不到就返回空日期）
    mocks.authenticatedRequest.mockResolvedValueOnce(jsonResponse({ ok: false, status: 404 }));

    const config = { passkey: '{}' };
    const result = await renewFreeDomain(config, 'demo.dpdns.org', 1);

    expect(mocks.loginWithPasskey).toHaveBeenCalledTimes(1);
    expect(mocks.authenticatedRequest).toHaveBeenCalledTimes(3); // renew 失败 + 重试成功 + 回查
    expect(result.newExpiryDate).toBe('');
  });

  it('只重试一次：第二次仍 CSRF 失败则抛错', async () => {
    // 一律返回 CSRF 失败：换签后重试仍失败，只允许换签一次
    mocks.authenticatedRequest.mockImplementation(async () => jsonResponse({ ok: false, error: 'Invalid CSRF token' }));

    await expect(renewFreeDomain({ passkey: '{}' }, 'demo.dpdns.org', 1)).rejects.toThrow(/CSRF/);
    expect(mocks.loginWithPasskey).toHaveBeenCalledTimes(1);
  });
});
