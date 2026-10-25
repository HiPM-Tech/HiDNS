import { describe, expect, it, vi } from 'vitest';
import { HuaweiAdapter } from '../huawei/adapter';

type RequestFn = (method: string, path: string, query?: Record<string, string> | null, body?: unknown) => Promise<unknown>;

function makeAdapter(request: RequestFn): HuaweiAdapter {
  const adapter = new HuaweiAdapter({ AccessKeyId: 'ak', SecretAccessKey: 'sk', zoneId: 'zone-1', domain: 'example.test' });
  (adapter as unknown as { client: { request: RequestFn } }).client.request = request;
  return adapter;
}

/**
 * 华为云线路语义（合并上游 PR #39 并按官方文档校正）：
 * - 线路 ID 空间没有 '0'，未指定时用 default_view；
 * - ListSystemLines 返回顺序不是契约，default_view 必须排首位；
 * - UpdateRecordSets 不接受 line（创建后不可改）。
 */
describe('Huawei 线路语义', () => {
  it('getRecordLines 使用系统线路并保证 default_view 在首位', async () => {
    const adapter = makeAdapter(async (_method, path) => {
      expect(path).toBe('/v2.1/system-lines');
      return {
        lines: [
          { id: 'Dianxin', name: '电信' },
          { id: 'Abroad', name: '境外' },
          { id: 'default_view', name: '默认' },
        ],
        metadata: { total_count: 3 },
      };
    });
    const lines = await adapter.getRecordLines();
    expect(lines[0]).toEqual({ id: 'default_view', name: '默认' });
    expect(lines.map((item) => item.id)).toContain('Abroad');
    expect(lines.some((item) => item.id === '0')).toBe(false);
  });

  it('ListSystemLines 返回空时抛错，不编造默认线路', async () => {
    const adapter = makeAdapter(async () => ({ lines: [], metadata: { total_count: 0 } }));
    await expect(adapter.getRecordLines()).rejects.toThrow(/线路列表为空/);
  });

  it('未指定线路或旧哨兵 0 都落到 default_view', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const adapter = makeAdapter(async (_method, _path, _query, body) => {
      bodies.push(body as Record<string, unknown>);
      return { id: 'rec-1' };
    });
    await adapter.addDomainRecord('www', 'A', '1.2.3.4');
    await adapter.addDomainRecord('www', 'A', '1.2.3.4', '0');
    await adapter.addDomainRecord('www', 'A', '1.2.3.4', 'Dianxin');
    expect(bodies[0].line).toBe('default_view');
    expect(bodies[1].line).toBe('default_view');
    expect(bodies[2].line).toBe('Dianxin');
  });

  it('update 不向上游发送 line（华为不支持改线路）', async () => {
    let sent: Record<string, unknown> | null = null;
    const adapter = makeAdapter(async (_method, _path, _query, body) => {
      sent = body as Record<string, unknown>;
      return {};
    });
    await adapter.updateDomainRecord('rec-1', 'www', 'A', '1.2.3.5', 'Dianxin');
    expect(sent).not.toBeNull();
    expect(sent).not.toHaveProperty('line');
  });
});
