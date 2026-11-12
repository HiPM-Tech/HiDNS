import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SpaceshipAdapter } from '../spaceship/adapter';

/**
 * 官方文档（https://docs.spaceship.dev/）：
 *   PUT    /v1/dns/records/{domain}  = Save resource records，body { force, items }，items 上限 500
 *   DELETE /v1/dns/records/{domain}  = Delete resource records（无请求体，等价清空该域名全部记录）
 * 所以「增/改/删单条」必须「读全量 → 改动 → 整体保存」，
 * 只 PUT 一条会把该域名其它记录一起清掉。
 */
function makeAdapter() {
  const adapter = new SpaceshipAdapter({ apiKey: 'k', apiSecret: 's', domain: 'example.com' }) as any;
  adapter.request = vi.fn();
  return adapter;
}

const www = { type: 'A', name: 'www', ttl: 600, address: '1.1.1.1' };
const api = { type: 'A', name: 'api', ttl: 600, address: '2.2.2.2' };

describe('SpaceshipAdapter 记录写操作（全量保存语义）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('添加记录：先读全量，再整体 PUT（不丢其它记录）', async () => {
    const adapter = makeAdapter();
    adapter.request.mockResolvedValueOnce({ items: [www], total: 1 });
    adapter.request.mockResolvedValueOnce(undefined);

    const id = await adapter.addDomainRecord('api', 'A', '2.2.2.2', undefined, 600, 1);

    expect(id).toBe('A|api|2.2.2.2|1');
    const [method, path, payload] = adapter.request.mock.calls[1];
    expect(method).toBe('PUT');
    expect(path).toBe('/dns/records/example.com');
    expect(payload.force).toBe(true);
    expect(payload.items).toHaveLength(2);
    expect(payload.items.map((item: any) => item.name)).toEqual(['www', 'api']);
  });

  it('删除记录：过滤目标行后整体 PUT', async () => {
    const adapter = makeAdapter();
    adapter.request.mockResolvedValueOnce({ items: [www, api], total: 2 });
    adapter.request.mockResolvedValueOnce(undefined);

    const ok = await adapter.deleteDomainRecord('A|www|1.1.1.1|0');

    expect(ok).toBe(true);
    const [method, , payload] = adapter.request.mock.calls[1];
    expect(method).toBe('PUT');
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].name).toBe('api');
  });

  it('删除最后一条记录：改用 DELETE 清空', async () => {
    const adapter = makeAdapter();
    adapter.request.mockResolvedValueOnce({ items: [www], total: 1 });
    adapter.request.mockResolvedValueOnce(undefined);

    const ok = await adapter.deleteDomainRecord('A|www|1.1.1.1|0');

    expect(ok).toBe(true);
    const [method, path, payload] = adapter.request.mock.calls[1];
    expect(method).toBe('DELETE');
    expect(path).toBe('/dns/records/example.com');
    expect(payload).toBeUndefined();
  });

  it('更新记录：替换目标行后整体 PUT', async () => {
    const adapter = makeAdapter();
    adapter.request.mockResolvedValueOnce({ items: [www, api], total: 2 });
    adapter.request.mockResolvedValueOnce(undefined);

    const ok = await adapter.updateDomainRecord('A|www|1.1.1.1|0', 'www', 'A', '3.3.3.3', undefined, 600, 1);

    expect(ok).toBe(true);
    const [method, , payload] = adapter.request.mock.calls[1];
    expect(method).toBe('PUT');
    expect(payload.items).toHaveLength(2);
    expect(payload.items[0].address).toBe('3.3.3.3');
    expect(payload.items[1].name).toBe('api');
  });


  it('并发写同一域名会串行执行，不互相覆盖（lost update）', async () => {
    const adapter = makeAdapter();
    let inFlight = 0;
    let maxInFlight = 0;
    let stored: any[] = [{ type: 'A', name: 'base', ttl: 600, address: '0.0.0.0' }];

    adapter.request = vi.fn(async (method: string, _path: string, payload?: any) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        if (method === 'GET') return { items: stored.map((item) => ({ ...item })), total: stored.length };
        if (method === 'PUT') {
          stored = (payload.items as any[]).map((item) => ({ ...item }));
          return undefined;
        }
        return undefined;
      } finally {
        inFlight -= 1;
      }
    });

    await Promise.all([
      adapter.addDomainRecord('a1', 'A', '1.1.1.1', undefined, 600, 1),
      adapter.addDomainRecord('a2', 'A', '2.2.2.2', undefined, 600, 1),
    ]);

    // 串行：任何时刻只有一个请求在飞
    expect(maxInFlight).toBe(1);
    // 两次追加都保留（若并发，后一次会用旧的全量覆盖前一次）
    expect(stored.map((item) => item.name).sort()).toEqual(['a1', 'a2', 'base']);
  });
  it('目标记录不存在时返回 false 且不发写请求', async () => {
    const adapter = makeAdapter();
    adapter.request.mockResolvedValueOnce({ items: [api], total: 1 });

    const ok = await adapter.deleteDomainRecord('A|www|1.1.1.1|0');

    expect(ok).toBe(false);
    expect(adapter.error).toContain('未找到');
    expect(adapter.request).toHaveBeenCalledTimes(1);
  });
});
