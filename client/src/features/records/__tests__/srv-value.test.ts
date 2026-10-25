import { describe, expect, it } from 'vitest';
import { composeRecordValue } from '../record-value';
import { validateRecordValue } from '../../../types/record-types';

/**
 * SRV 记录（第五轮 E2E 卡点）：
 * 表单把 priority/weight/port 拼进 value，服务端按「四段」校验；
 * 若仍按 hostname 校验整串，UI 新建 SRV 必然失败。
 */
describe('SRV 记录值', () => {
  it('拼成四段并通过校验', () => {
    const composed = composeRecordValue(
      [{ key: 'priority' }, { key: 'weight' }, { key: 'port' }],
      { priority: '10', weight: '5', port: '8080' },
      'sip.example.test',
    );
    expect(composed).toBe('10 5 8080 sip.example.test');
    expect(validateRecordValue('SRV', composed)).toBeNull();
  });

  it('段数不对或端口越界时报错', () => {
    expect(validateRecordValue('SRV', '10 5 sip.example.test')).toContain('四段');
    expect(validateRecordValue('SRV', '10 5 70000 sip.example.test')).toContain('端口');
    expect(validateRecordValue('SRV', '10 5 8080 -bad')).toBeTruthy();
  });
});
