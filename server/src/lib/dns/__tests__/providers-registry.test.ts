import { describe, it, expect, vi, afterEach } from 'vitest';
import { getProviders, isStubProvider } from '../DnsHelper';
import { PROVIDER_TYPES } from '../providers/registry';
import { ALL_ACTIONS } from '../../../workflow/actions/registry';
import { isVirtualProviderEnabled, virtualProviderDisabledReason } from '../providers/availability';
import { VirtualAdapter } from '../providers/virtual/adapter';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV;
  if (ORIGINAL_ENV.HIDNS_ENABLE_VIRTUAL_PROVIDER === undefined) {
    delete process.env.HIDNS_ENABLE_VIRTUAL_PROVIDER;
  } else {
    process.env.HIDNS_ENABLE_VIRTUAL_PROVIDER = ORIGINAL_ENV.HIDNS_ENABLE_VIRTUAL_PROVIDER;
  }
});

/**
 * 提供商列表契约。
 *
 * 背景：曾出现"虚拟提供商在生产不显示"的反馈。排查结论是服务端注册与返回都正常，
 * 问题在部署产物未重建。这里把这个契约锁住：
 * 只要有任何过滤把注册的提供商从 /api/accounts/providers 的返回里漏掉，CI 立刻失败。
 */
describe('虚拟提供商的可用性开关', () => {
  it('生产环境即使显式打开也关闭', () => {
    expect(isVirtualProviderEnabled({ NODE_ENV: 'production', HIDNS_ENABLE_VIRTUAL_PROVIDER: '1' })).toBe(false);
    expect(virtualProviderDisabledReason({ NODE_ENV: 'production' })).toMatch(/仅用于开发环境/);
  });

  it('未设置开关时关闭（失败关闭）', () => {
    expect(isVirtualProviderEnabled({ NODE_ENV: 'development' })).toBe(false);
    expect(isVirtualProviderEnabled({})).toBe(false);
    expect(isVirtualProviderEnabled({ NODE_ENV: 'development', HIDNS_ENABLE_VIRTUAL_PROVIDER: '0' })).toBe(false);
  });

  it('显式开关打开时可用', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(isVirtualProviderEnabled({ NODE_ENV: 'development', HIDNS_ENABLE_VIRTUAL_PROVIDER: value })).toBe(true);
    }
  });

  it('关闭时注册表里没有虚拟提供商，也没有对应动作', async () => {
    delete process.env.HIDNS_ENABLE_VIRTUAL_PROVIDER;
    vi.resetModules();
    try {
      const registry = await import('../providers/registry');
      const actions = await import('../../../workflow/actions/registry');
      expect(registry.PROVIDER_TYPES).not.toContain('virtual');
      expect(actions.ALL_ACTIONS.some((action) => action.name.startsWith('ext.virtual.'))).toBe(false);
    } finally {
      process.env.HIDNS_ENABLE_VIRTUAL_PROVIDER = '1';
      vi.resetModules();
    }
  });

  it('关闭时适配器拒绝一切操作', async () => {
    delete process.env.HIDNS_ENABLE_VIRTUAL_PROVIDER;
    const adapter = new VirtualAdapter({
      virtual_enabled: 'true',
      virtual_state: 'memory',
      virtual_tenant: 'gate',
    });
    await expect(adapter.check()).resolves.toBe(false);
    await expect(adapter.getDomainList()).rejects.toThrow(/未启用|仅用于开发环境/);
    expect(() => adapter.originGroups()).toThrow();
  });
});

describe('提供商列表契约', () => {
  it('注册表里的每个提供商都会出现在 getProviders() 结果中', () => {
    const listed = new Set(getProviders().map((provider) => provider.type));
    const missing = PROVIDER_TYPES.filter((type) => !listed.has(type));
    expect(missing).toEqual([]);
  });

  it('虚拟提供商已注册且默认不被当作桩', () => {
    expect(PROVIDER_TYPES).toContain('virtual');
    expect(isStubProvider('virtual')).toBe(false);
    const virtual = getProviders().find((provider) => provider.type === 'virtual');
    expect(virtual).toBeTruthy();
  });

  it('虚拟提供商必须要求显式启用参数', () => {
    const virtual = getProviders().find((provider) => provider.type === 'virtual')!;
    const enabled = virtual.configFields.find((field) => field.key === 'virtual_enabled');
    expect(enabled, 'virtual_enabled 字段缺失会导致默认可用').toBeTruthy();
    expect(enabled!.required).toBe(true);
    expect(enabled!.options?.map((option) => option.value).sort()).toEqual(['false', 'true']);
  });

  it('虚拟提供商不要求任何真实凭证字段', () => {
    const virtual = getProviders().find((provider) => provider.type === 'virtual')!;
    const keys = virtual.configFields.map((field) => field.key);
    for (const credential of ['SecretId', 'SecretKey', 'AccessKeyId', 'AccessKeySecret', 'api_token', 'api_key']) {
      expect(keys).not.toContain(credential);
    }
  });

  it('虚拟提供商的四个动作都在注册表中且对 DSL 可见', () => {
    const names = ALL_ACTIONS.map((action) => action.name).filter((name) => name.startsWith('ext.virtual.'));
    expect(names.sort()).toEqual([
      'ext.virtual.originGroup.get',
      'ext.virtual.originGroup.list',
      'ext.virtual.originGroup.planSync',
      'ext.virtual.originGroup.sync',
    ]);
    for (const name of names) {
      const action = ALL_ACTIONS.find((item) => item.name === name)!;
      expect(action.dslVisible, name).toBe(true);
    }
  });
});
