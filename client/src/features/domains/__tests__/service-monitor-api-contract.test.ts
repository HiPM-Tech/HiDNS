import { afterEach, describe, expect, it, vi } from 'vitest';
import { serviceMonitorApi } from '../service-monitor-api';

function mockFetch(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })));
}

describe('serviceMonitorApi 契约', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('list 读取 {list,total}', async () => {
    mockFetch({ code: 0, msg: 'success', data: { list: [{ id: 1, name: 'm' }], total: 1 } });
    const result = await serviceMonitorApi.list({ page: 1, pageSize: 10 });
    expect(result).toEqual({ list: [{ id: 1, name: 'm' }], total: 1 });
  });

  it('create 非 0 业务码抛错', async () => {
    mockFetch({ code: 422, msg: 'invalid port', data: null });
    await expect(serviceMonitorApi.create({ name: 'm' } as never)).rejects.toThrow(/invalid port/);
  });
});
