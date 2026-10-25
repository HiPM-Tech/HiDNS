import { describe, expect, it } from 'vitest';
import { createAdapter } from '../DnsHelper';

/**
 * 工厂入口必须做别名归一化：providerAlias 表存在（alidns/aliesa/edgeone…），
 * 但历史实现只查 providerDefinitionMap，别名会抛 Unknown provider type。
 */
describe('createAdapter 别名归一化', () => {
  it('lego 别名可创建适配器', () => {
    const adapter = createAdapter('alidns', {});
    expect(adapter.constructor.name).toContain('Aliyun');
  });

  it('大小写与首尾空白同样归一', () => {
    // 云厂商适配器可能因缺少凭据在构造期抛业务错误，但绝不能是「未知提供商」
    try {
      createAdapter(' CloudFlare ', {});
    } catch (error) {
      expect(String(error)).not.toMatch(/Unknown provider type/);
    }
  });

  it('未知类型仍然报错（不静默降级）', () => {
    expect(() => createAdapter('not-a-provider', {})).toThrow(/Unknown provider type/);
  });
});
