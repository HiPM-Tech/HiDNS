import { describe, expect, it } from 'vitest';
import { composeRecordValue } from '../record-value';

/**
 * 记录值拼装（E2E 发现的 P0 回归）。
 * MX 的优先级必须走独立字段 `mx`，拼进 value 会让 hostname 校验失败、UI 无法新建 MX。
 */
describe('composeRecordValue', () => {
  it('MX 不把优先级拼进 value', () => {
    expect(composeRecordValue([{ key: 'mx' }], { mx: '10' }, 'mail.example.test')).toBe('mail.example.test');
  });

  it('SRV 的 priority/port 仍拼在 value 前（没有独立字段）', () => {
    expect(composeRecordValue(
      [{ key: 'priority' }, { key: 'weight' }, { key: 'port' }],
      { priority: '10', weight: '5', port: '8080' },
      'srv.example.test',
    )).toBe('10 5 8080 srv.example.test');
  });

  it('没有附加字段时返回原值（去空白）', () => {
    expect(composeRecordValue([], {}, '  1.2.3.4 ')).toBe('1.2.3.4');
  });
});
