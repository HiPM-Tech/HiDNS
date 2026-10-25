import { afterEach, describe, expect, it, vi } from 'vitest';
import { listNsMonitors, checkNsRecord } from '../ns-monitor-api';

/**
 * 守的是「真实信封」而不是「组件里的替身」：
 * 第四轮终审的 P0-1 就是因为后端返回 {success:true} 无 code、前端组件用例又把 api 层整体 mock 掉，
 * 于是 7 个端点全废却全绿。这里用 fetch stub 走真实 lib/http。
 */
function mockFetch(body: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })));
}

describe('ns-monitor api 信封', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('标准 {code,data} 信封能解析出列表', async () => {
    mockFetch({ code: 0, msg: 'success', data: { list: [{ id: 1, domain_name: 'example.com' }], total: 1 } });
    const result = await listNsMonitors({ page: 1, pageSize: 20 });
    expect(result.total).toBe(1);
    expect(result.list[0].domain_name).toBe('example.com');
  });

  it('后端若退回裸 {success:true}，客户端明确报错而不是静默空列表', async () => {
    mockFetch({ success: true, data: { list: [], total: 0 } });
    await expect(listNsMonitors({ page: 1, pageSize: 20 })).rejects.toThrow();
  });

  it('check 返回当前 NS 与状态', async () => {
    mockFetch({ code: 0, msg: 'success', data: { current_ns: ['ns1.example.com'], expected_ns: ['ns1.example.com'], status: 'ok' } });
    const result = await checkNsRecord('example.com');
    expect(result.status).toBe('ok');
    expect(result.current_ns).toEqual(['ns1.example.com']);
  });
});
