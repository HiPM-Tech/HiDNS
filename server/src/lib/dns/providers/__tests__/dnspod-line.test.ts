import { describe, expect, it, vi } from 'vitest';
import { DnspodAdapter } from '../dnspod/adapter';

/**
 * DDNS-Go 兼容回归：它更新记录时固定传 line:"0"。
 * DNSPod 的 RecordLine 是线路名称（默认线路叫「默认」），把 '0' 当名称传会报
 * InvalidParameter.RecordLineInvalid；因此必须只传 RecordLineId。
 */
describe('DNSPod 更新记录的线路参数', () => {
  it('line=0 时 RecordLine=默认', async () => {
    const adapter = new DnspodAdapter({ SecretId: 'id', SecretKey: 'key', domain: 'example.com' });
    const call = vi.fn(async (..._args: unknown[]) => ({}));
    (adapter as unknown as { call: typeof call }).call = call;

    await adapter.updateDomainRecord('123', 'www', 'A', '1.2.3.4');
    const payload = (call.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(payload.RecordLine).toBe('默认');
    expect(payload).not.toHaveProperty('RecordLineId');
  });

  it('传入「默认」原样保留', async () => {
    const adapter = new DnspodAdapter({ SecretId: 'id', SecretKey: 'key', domain: 'example.com' });
    const call = vi.fn(async (..._args: unknown[]) => ({}));
    (adapter as unknown as { call: typeof call }).call = call;
    await adapter.addDomainRecord('www', 'A', '1.2.3.4', '默认');
    expect(((call.mock.calls[0] as unknown[])[1] as Record<string, unknown>).RecordLine).toBe('默认');
  });

  it('显式线路 ID 映射为中文名称', async () => {
    const adapter = new DnspodAdapter({ SecretId: 'id', SecretKey: 'key', domain: 'example.com' });
    const call = vi.fn(async () => ({}));
    (adapter as unknown as { call: typeof call }).call = call;
    await adapter.updateDomainRecord('123', 'www', 'A', '1.2.3.4', '10=0');
    const payload = (call.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(payload.RecordLine).toBe('电信');
    expect(payload).not.toHaveProperty('RecordLineId');
  });
});
