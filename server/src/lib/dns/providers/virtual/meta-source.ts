import { VirtualAdapter } from './adapter';
import { registerProviderMetaSource } from '../meta-sources';
import type { ProviderMetaContext, ProviderMetaItem } from '../meta-sources';

/**
 * 虚拟提供商的源站组候选值。
 *
 * 注意：候选源注册表只按 `source` 索引（`ProviderMetaSource.providerType` 目前未参与索引），
 * 因此这里用独立的名字 `virtualOriginGroups`，而不是复用 `originGroups`——
 * 复用会让虚拟域名命中腾讯云的实现并报"不支持源站组"。
 */
registerProviderMetaSource({
  source: 'virtualOriginGroups',
  providerType: 'virtual',
  async resolve(ctx: ProviderMetaContext): Promise<ProviderMetaItem[]> {
    if (!(ctx.adapter instanceof VirtualAdapter)) {
      throw new Error('该域名的提供商不是虚拟提供商');
    }
    ctx.adapter.setZoneInfo(ctx.zoneId, ctx.domainName);
    const groups = await ctx.adapter.originGroups().list({ limit: 1000 });
    return groups.map((group) => ({
      value: group.groupId,
      label: group.name || group.groupId,
      records: group.records.length,
      references: group.references.length,
    }));
  },
});
