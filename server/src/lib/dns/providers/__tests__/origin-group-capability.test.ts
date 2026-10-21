import { describe, it, expect } from 'vitest';
import { getOriginGroupCapability } from '../registry';
import { isOriginGroupCapableAccount } from '../registry';

describe('源站组能力位（设计 §2.2）', () => {
  it('由 extraCapabilities 派生：tencenteo 与 virtual 原生支持', () => {
    expect(getOriginGroupCapability('tencenteo')).toBe(true);
    // virtual 也提供 ext.virtual.originGroup.*，且内置预设在用
    expect(getOriginGroupCapability('virtual')).toBe(true);
  });

  it('普通 DNS 提供商不原生支持', () => {
    expect(getOriginGroupCapability('cloudflare')).toBe(false);
    expect(getOriginGroupCapability('aliyun')).toBe(false);
  });

  it('账号可操作性 = 原生支持 ∪ 允许复用凭据', () => {
    expect(isOriginGroupCapableAccount('tencenteo')).toBe(true);
    // 关键一支：DNSPod 账号能操作源站组，靠的是复用腾讯云凭据；
    // 漏掉这条会让唯一能用源站组的用户群在 UI 里失去入口
    expect(isOriginGroupCapableAccount('dnspod')).toBe(true);
    expect(isOriginGroupCapableAccount('cloudflare')).toBe(false);
  });

  it('未知/空类型不因异常而放行', () => {
    expect(isOriginGroupCapableAccount('')).toBe(false);
    expect(isOriginGroupCapableAccount('not-a-provider')).toBe(false);
  });
});
