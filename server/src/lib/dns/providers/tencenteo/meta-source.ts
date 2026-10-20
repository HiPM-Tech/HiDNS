import { registerProviderMetaSource } from '../meta-sources';
import type { ProviderMetaContext, ProviderMetaItem } from '../meta-sources';
import { teoOpsForDomain } from './teo-ops';

/**
 * EdgeOne 源站组候选值。
 *
 * 鉴权解析与能力层共用 `teoOpsForDomain`：EdgeOne 账号直接用 third_id 与账号配置里的站点类型；
 * DNSPod 账号则复用同一对腾讯云密钥调用 TEO，并按前端声明的 siteType 选择国内站/国际站。
 * 非这两类账号会抛出可读错误，由路由转成 502，而不是静默返回空列表。
 */
registerProviderMetaSource({
  source: 'originGroups',
  providerType: 'tencenteo',
  async resolve(ctx: ProviderMetaContext): Promise<ProviderMetaItem[]> {
    const { ops } = await teoOpsForDomain(ctx.domainId, { siteType: ctx.params?.siteType });
    const groups = await ops.list({ limit: 100 });
    return groups.map((group) => ({
      value: group.groupId,
      label: group.name || group.groupId,
      records: group.records.length,
      references: group.references.length,
    }));
  },
});
