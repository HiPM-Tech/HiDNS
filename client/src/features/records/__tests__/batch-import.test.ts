import { describe, expect, it } from 'vitest';
import { parseBatchLine } from '../batch-import-dialog';

describe('parseBatchLine', () => {
  it('解析标准四列并保留备注', () => {
    const row = parseBatchLine('www A 1.2.3.4 600 主站', 0);
    expect(row.payload).toEqual({ name: 'www', type: 'A', value: '1.2.3.4', ttl: 600, remark: '主站' });
  });

  it('引号内的空格不切分，TTL 可省略', () => {
    const row = parseBatchLine('_dmarc TXT "v=DMARC1; p=none"', 0);
    expect(row.payload).toEqual({ name: '_dmarc', type: 'TXT', value: 'v=DMARC1; p=none', ttl: undefined, remark: undefined });
  });

  it('注释与空行被忽略，列数不足报错', () => {
    expect(parseBatchLine('# 注释', 0).payload).toBeUndefined();
    expect(parseBatchLine('# 注释', 0).error).toBeUndefined();
    expect(parseBatchLine('   ', 0).payload).toBeUndefined();
    expect(parseBatchLine('www A', 0).error).toContain('至少需要');
  });

  it('类型统一大写', () => {
    expect(parseBatchLine('mail mx mail.example.com', 0).payload?.type).toBe('MX');
  });
});
