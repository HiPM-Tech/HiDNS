import { VirtualAdapter } from './adapter';
import { registerProviderMetaSource, requireDomainId } from '../meta-sources';
import type { ProviderMetaContext, ProviderMetaItem } from '../meta-sources';
import { isVirtualProviderEnabled } from '../availability';

/**
 * 虚拟提供商的源站组候选值。
 *
 * 注意：候选源注册表只按 `source` 索引（`ProviderMetaSource.providerType` 目前未参与索引），
 * 因此这里用独立的名字 `virtualOriginGroups`，而不是复用 `originGroups`——
 * 复用会让虚拟域名命中腾讯云的实现并报"不支持源站组"。
 *
 * 注册本身受可用性开关控制：生产环境不注册，避免候选接口里出现只属于开发环境的源。
 */
if (isVirtualProviderEnabled()) {
  registerProviderMetaSource({
    source: 'virtualOriginGroups',
    providerType: 'virtual',
    async resolve(ctx: ProviderMetaContext): Promise<ProviderMetaItem[]> {
      if (!(ctx.adapter instanceof VirtualAdapter)) {
        throw new Error('该域名的提供商不是虚拟提供商');
      }
      ctx.adapter.setZoneInfo(ctx.zoneId ?? '', ctx.domainName ?? '');
      const groups = await ctx.adapter.originGroups().list({ limit: 1000 });
      return groups.map((group) => ({
        value: group.groupId,
        label: group.name || group.groupId,
        records: group.records.length,
        references: group.references.length,
      }));
    },
  });
}
