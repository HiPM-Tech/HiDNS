import { afterEach, describe, expect, it, vi } from 'vitest';
import { listAccounts, listProviders } from '../api';

function mockFetch(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })));
}

describe('accounts API 契约', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('listAccounts 兼容数组与 {list} 两种形状', async () => {
    mockFetch({ code: 0, msg: 'success', data: [{ id: 1, type: 'aliyun' }] });
    expect(await listAccounts()).toHaveLength(1);
    mockFetch({ code: 0, msg: 'success', data: { list: [{ id: 2, type: 'cloudflare' }] } });
    expect(await listAccounts()).toEqual([{ id: 2, type: 'cloudflare' }]);
  });

  it('listProviders 返回数组（含 lineSource/defaultLine）', async () => {
    mockFetch({ code: 0, msg: 'success', data: [{ type: 'huawei', lineSource: 'dynamic', defaultLine: 'default_view' }] });
    const providers = await listProviders();
    expect(providers[0]).toMatchObject({ type: 'huawei', defaultLine: 'default_view' });
  });
});
