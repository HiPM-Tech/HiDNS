import type { ProviderInfo } from './api';

/**
 * 按提供商能力过滤账户（客户端侧，避免把「不能解析域名 / 不能续期」的账户放进选择列表）。
 * providers 尚未加载时返回原列表，避免首屏出现空列表。
 */
export function filterAccountsByProviderCapability<T extends { type: string }>(
  accounts: T[],
  providers: ProviderInfo[] | undefined,
  capability: 'dns' | 'renewal',
): T[] {
  if (!providers || providers.length === 0) return accounts;
  const allowed = new Set(
    providers
      .filter((provider) => {
        if (provider.isStub) return false;
        if (capability === 'dns') return provider.capabilities.dns !== null;
        return provider.capabilities.renewal === true;
      })
      .map((provider) => provider.type),
  );
  return accounts.filter((account) => allowed.has(account.type));
}
