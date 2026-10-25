import { describe, expect, it } from 'vitest';
import { isPrivateAddress, resolvePublicTarget } from '../serviceMonitor';

/**
 * SSRF 守卫回归（渗透测试第二轮 #5）：
 * - 非 IP 输入不能被当成私有地址（否则 example.com 也会被拒，endpoint 监控全失效）；
 * - IP 字面量不走 DNS（否则填 IP 的监控会被解析器打回）；
 * - 内网/保留地址必须拒绝。
 */
describe('isPrivateAddress', () => {
  it('私有与保留地址返回 true', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fe80::1', 'fd00::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('公网地址与域名返回 false', () => {
    for (const value of ['1.1.1.1', '8.8.8.8', 'example.com', 'a.example.com']) {
      expect(isPrivateAddress(value), value).toBe(false);
    }
  });
});

describe('resolvePublicTarget', () => {
  it('IP 字面量：内网拒绝、公网放行（不做 DNS）', async () => {
    expect((await resolvePublicTarget('127.0.0.1')).ok).toBe(false);
    expect((await resolvePublicTarget('169.254.169.254')).ok).toBe(false);
    expect((await resolvePublicTarget('1.1.1.1')).ok).toBe(true);
  });
});
