import { describe, expect, it } from 'vitest';
import { providerLabel, configFieldLabel } from '../provider-labels';

/**
 * 后端 registry 给的 name / configFields[].label 是 i18n key；
 * 去掉 i18n 框架后曾直接渲染成 provider.virtual / provider.config.xxx（E2E 走查发现）。
 */
describe('providerLabel', () => {
  it('type 与 i18n key 都能翻成中文', () => {
    expect(providerLabel('virtual')).toBe('虚拟（测试）');
    expect(providerLabel('provider.aliyun')).toBe('阿里云');
    expect(providerLabel('cloudflare')).toBe('Cloudflare');
  });

  it('未知 key 回退到末段，不把 provider. 前缀露给用户', () => {
    expect(providerLabel('provider.some_new_provider')).toBe('some_new_provider');
    expect(providerLabel('')).toBe('');
  });
});

describe('configFieldLabel', () => {
  it('已知配置项翻成中文', () => {
    expect(configFieldLabel('provider.config.api_token')).toBe('API Token');
    expect(configFieldLabel('provider.config.virtual_enabled_on')).toBe('启用虚拟站点');
  });

  it('已经是可读文本时原样返回', () => {
    expect(configFieldLabel('备注')).toBe('备注');
  });

  it('未知配置项去掉前缀', () => {
    expect(configFieldLabel('provider.config.foo_bar')).toBe('foo_bar');
  });
});
