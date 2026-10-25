import { describe, expect, it, vi } from 'vitest';
import { AliyunAdapter } from '../aliyun/adapter';

function makeAdapter(handler?: (action: string, params: Record<string, unknown>) => unknown) {
  const adapter = new AliyunAdapter({ AccessKeyId: 'ak', AccessKeySecret: 'sk', domain: 'example.com' });
  const calls: Array<[string, Record<string, unknown>]> = [];
  (adapter as unknown as { rpcCall: unknown }).rpcCall = vi.fn(async (action: string, params: Record<string, unknown>) => {
    calls.push([action, params]);
    return handler ? handler(action, params) : (action === 'AddDomainRecord' ? { RecordId: 'r1' } : {});
  });
  return { adapter, calls };
}

/**
 * 阿里云 AddDomainRecord/UpdateDomainRecord 的 Line 默认值是 default（不是 '0'）。
 * 历史实现未指定线路时发送 '0'，与 DNSPod 的「值域不对」同类。
 */
describe('Aliyun 线路默认值', () => {
  it('未指定线路发送 default', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.addDomainRecord('www', 'A', '1.2.3.4');
    expect(calls[0][1].Line).toBe('default');
  });

  it('真实线路原样透传', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.addDomainRecord('www', 'A', '1.2.3.4', 'Dianxin');
    expect(calls[0][1].Line).toBe('Dianxin');
  });

  it('旧哨兵 0 归一为 default', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.addDomainRecord('www', 'A', '1.2.3.4', '0');
    expect(calls[0][1].Line).toBe('default');
  });

  it('线路列表为空时兜底 id 使用 default', async () => {
    const { adapter } = makeAdapter(() => ({}));
    const lines = await adapter.getRecordLines();
    expect(lines).toEqual([{ id: 'default', name: '默认' }]);
  });
});
