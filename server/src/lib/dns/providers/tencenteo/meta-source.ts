import { TencenteoAdapter } from './adapter';
import { registerProviderMetaSource } from '../meta-sources';
import type { ProviderMetaContext, ProviderMetaItem } from '../meta-sources';

registerProviderMetaSource({
  source: 'originGroups',
  providerType: 'tencenteo',
  async resolve(ctx: ProviderMetaContext): Promise<ProviderMetaItem[]> {
    if (!(ctx.adapter instanceof TencenteoAdapter)) {
      throw new Error('该域名的提供商不支持源站组');
    }
    ctx.adapter.setZoneInfo(ctx.zoneId, ctx.domainName);
    const groups = await ctx.adapter.originGroups().list({ limit: 100 });
    return groups.map((group) => ({
      value: group.groupId,
      label: group.name || group.groupId,
      records: group.records.length,
      references: group.references.length,
    }));
  },
});