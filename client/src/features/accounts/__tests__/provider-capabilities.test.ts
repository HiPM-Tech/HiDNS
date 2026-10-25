import { describe, expect, it } from 'vitest';
import { filterAccountsByProviderCapability } from '../provider-capabilities';
import type { ProviderInfo } from '../api';

const providers = [
  { type: 'aliyun', capabilities: { dns: { recordTypes: [] }, log: true, renewal: false } },
  { type: 'namesilo', capabilities: { dns: { recordTypes: [] }, log: true, renewal: true } },
  { type: 'edgeone', capabilities: { dns: null, log: false, renewal: false } },
  { type: 'stub', isStub: true, capabilities: { dns: { recordTypes: [] }, log: true, renewal: true } },
] as unknown as ProviderInfo[];

const accounts = [
  { id: 1, type: 'aliyun' },
  { id: 2, type: 'namesilo' },
  { id: 3, type: 'edgeone' },
  { id: 4, type: 'stub' },
];

describe('filterAccountsByProviderCapability', () => {
  it('DNS 解析：排除 dns=null 与 stub 账户', () => {
    expect(filterAccountsByProviderCapability(accounts, providers, 'dns').map((a) => a.id)).toEqual([1, 2]);
  });

  it('续期：只保留 renewal=true 的提供商账户', () => {
    expect(filterAccountsByProviderCapability(accounts, providers, 'renewal').map((a) => a.id)).toEqual([2]);
  });

  it('providers 未加载时不过滤（首屏不闪空列表）', () => {
    expect(filterAccountsByProviderCapability(accounts, undefined, 'dns')).toHaveLength(4);
  });
});
