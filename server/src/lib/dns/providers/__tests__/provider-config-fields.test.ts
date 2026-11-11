import { describe, expect, it } from 'vitest';
import { getProviderInfoList } from '../registry';

/**
 * 「是否直连」开关是账号级通用字段：所有 provider 都要下发，
 * 否则新增/编辑账号时只有部分提供商能看到这个开关。
 */
describe('通用网络开关 useProxy', () => {
  it('每个 provider 的 configFields 都带 useProxy（boolean，非必填）', () => {
    for (const provider of getProviderInfoList()) {
      const field = provider.configFields.find((item) => item.key === 'useProxy');
      expect(field, `${provider.type} 缺少 useProxy 字段`).toBeTruthy();
      expect(field?.type).toBe('boolean');
      expect(field?.required).toBe(false);
    }
  });

  it('不重复注入', () => {
    for (const provider of getProviderInfoList()) {
      expect(provider.configFields.filter((item) => item.key === 'useProxy')).toHaveLength(1);
    }
  });
});
