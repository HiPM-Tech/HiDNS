import { afterEach, describe, expect, it, vi } from 'vitest';
import { listDomains } from '../api';

function mockFetch(body: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })));
}

describe('listDomains 契约', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('读取 list/total 并补默认分页', async () => {
    mockFetch({ code: 0, msg: 'success', data: { list: [{ id: 1, name: 'a.test' }], total: 1 } });
    const result = await listDomains({ page: 1, pageSize: 20 });
    expect(result.list).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.totalPages).toBe(1);
  });

  it('非 0 业务码抛错', async () => {
    mockFetch({ code: 403, msg: 'Permission denied', data: null }, 403);
    await expect(listDomains({ page: 1, pageSize: 20 })).rejects.toThrow(/Permission/);
  });
});
