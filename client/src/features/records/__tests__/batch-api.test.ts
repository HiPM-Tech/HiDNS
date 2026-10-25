import { afterEach, describe, expect, it, vi } from 'vitest';
import { batchCreateRecords } from '../api';
import type { RecordPayload } from '../api';

/**
 * 批量导入的契约守在这里：后端返回逐条 results（line/ok/recordId/error）。
 * 第四轮 P0-2 的教训——组件用例把 batchCreateRecords 整体 mock 掉，
 * 于是「后端只回 addedIds、前端读 results」的错配一直没被发现。
 */
function mockFetch(body: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })));
}

const payload = [{ name: 'www', type: 'A', value: '1.2.3.4' }] as RecordPayload[];

describe('batchCreateRecords 契约', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('读取逐条 results 与 addedIds', async () => {
    mockFetch({
      code: 0, msg: 'success',
      data: {
        total: 2,
        addedIds: ['r1'],
        results: [{ line: 1, ok: true, recordId: 'r1' }, { line: 2, ok: false, error: 'TXT 值过长' }],
      },
    });
    const result = await batchCreateRecords(1, payload);
    expect(result.results).toHaveLength(2);
    expect(result.results[1]).toMatchObject({ line: 2, ok: false, error: 'TXT 值过长' });
    expect(result.addedIds).toEqual(['r1']);
  });

  it('非 0 业务码抛错（不会把失败当成功）', async () => {
    mockFetch({ code: 400, msg: 'records array is required', data: null }, 400);
    await expect(batchCreateRecords(1, payload)).rejects.toThrow();
  });
});
