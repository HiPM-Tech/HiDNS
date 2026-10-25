import { describe, expect, it } from 'vitest';
import { sliceWhoisBatch } from '../whois/scheduler';
import { isPrivateAddress } from '../serviceMonitor';

/** WHOIS 分片必须轮转（第三轮 R3）：此前 slice(0,200) 让 201+ 永不处理 */
describe('sliceWhoisBatch', () => {
  it('短列表一次处理完并重置游标', () => {
    const result = sliceWhoisBatch([1, 2, 3], 200, 5);
    expect(result.batch).toEqual([1, 2, 3]);
    expect(result.nextCursor).toBe(0);
  });

  it('长列表按游标轮转，两轮覆盖全部元素', () => {
    const domains = Array.from({ length: 250 }, (_, i) => i + 1);
    const first = sliceWhoisBatch(domains, 200, 0);
    const second = sliceWhoisBatch(domains, 200, first.nextCursor);
    const covered = new Set([...first.batch, ...second.batch]);
    expect(covered.size).toBe(250);
    // 第二轮必须包含此前从未被处理的 201..250
    expect(second.batch).toContain(250);
  });

  it('limit 非法时不崩', () => {
    expect(sliceWhoisBatch([1, 2], 0, 0).batch).toEqual([]);
  });
});

/** 映射型 IPv6 必须被判为内网（第三轮 N1） */
describe('isPrivateAddress：IPv4 映射地址', () => {
  it('点分与十六进制两种写法都拦', () => {
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:7f00:1')).toBe(true);
    expect(isPrivateAddress('::ffff:a9fe:a9fe')).toBe(true);
  });

  it('公网映射地址放行', () => {
    expect(isPrivateAddress('::ffff:101:101')).toBe(false); // 1.1.1.1
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });
});
