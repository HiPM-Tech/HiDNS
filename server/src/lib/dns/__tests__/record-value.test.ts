import { describe, expect, it } from 'vitest';
import { validateRecordValue } from '../record-types';

/**
 * 记录值校验的边界。
 *
 * 背景：这些校验存在的意义不是「让厂商少报错」，而是让用户看得懂——
 * 厂商侧的 InvalidParameter.RecordValueInvalid 只会说「记录的值不正确」。
 */
describe('validateRecordValue', () => {
  describe('SRV', () => {
    it('接受「优先级 权重 端口 主机名」四段', () => {
      expect(validateRecordValue('SRV', '10 5 5060 sip.example.com')).toBeNull();
    });

    it('目标填 IPv4 时明确指出不能是 IP', () => {
      const err = validateRecordValue('SRV', '10 5 5060 1.2.3.4');
      expect(err).toContain('不能填 IP');
    });

    it('目标填 IPv6 时同样拒绝', () => {
      const err = validateRecordValue('SRV', '10 5 5060 2001:db8::1');
      expect(err).toContain('不能填 IP');
    });

    it('段数不对时说明需要四段', () => {
      expect(validateRecordValue('SRV', '10 5 5060')).toContain('四段');
    });
  });

  describe('指向类型的目标必须是主机名', () => {
    for (const type of ['CNAME', 'MX', 'NS'] as const) {
      it(`${type} 拒绝 IP 字面量`, () => {
        const err = validateRecordValue(type, '203.0.113.10');
        expect(err).toContain('不能填 IP');
      });
    }

    it('CNAME 接受主机名', () => {
      expect(validateRecordValue('CNAME', 'target.example.com')).toBeNull();
    });
  });

  describe('TXT 单段长度', () => {
    it('255 字节以内直接通过', () => {
      expect(validateRecordValue('TXT', 'v=spf1 include:_spf.example.com ~all')).toBeNull();
    });

    it('不再按 255 字节拦截（2026-11-28 决策）', () => {
      // 各厂商对超长 TXT 的处理不一致（自动分段 / 直接拒绝 / 静默截断），
      // 本地拦截会把「厂商其实支持」的用法挡在门外；改为放行，由厂商结果 + describeProviderError 反馈。
      expect(validateRecordValue('TXT', 'a'.repeat(300))).toBeNull();
    });

    it('已经写成多段引号形式时放行', () => {
      const chunked = `"${'a'.repeat(200)}" "${'b'.repeat(200)}"`;
      expect(validateRecordValue('TXT', chunked)).toBeNull();
    });
  });

  describe('A / AAAA', () => {
    it('A 拒绝 IPv6', () => {
      expect(validateRecordValue('A', '2001:db8::1')).not.toBeNull();
    });

    it('AAAA 拒绝 IPv4', () => {
      expect(validateRecordValue('AAAA', '1.2.3.4')).not.toBeNull();
    });
  });
});
