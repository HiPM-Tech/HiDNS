import type { ProviderDomainOption } from './renewal-api';

/** 已加入续期列表的域名不再出现在「添加」里（后端给 exists_renewable，前端再兜一层） */
export function filterAddableRenewalDomains(items: ProviderDomainOption[]): ProviderDomainOption[] {
  return items.filter((item) => !item.exists_renewable);
}