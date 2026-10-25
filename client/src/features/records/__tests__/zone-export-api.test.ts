import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportZone } from '../api';

describe('exportZone 契约', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('带 nameFormat 查询并返回 content/filename', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 0, msg: 'success', data: { content: 'www 600 IN A 1.2.3.4', filename: 'example.com.zone' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await exportZone(7, 'full');
    expect(result.filename).toBe('example.com.zone');
    expect(result.content).toContain('www');
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toContain('/domains/7/records/export/zone');
    expect(url).toContain('nameFormat=full');
  });
});
