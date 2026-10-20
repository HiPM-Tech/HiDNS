import { registerProviderMetaSource } from '../meta-sources';
import type { ProviderMetaContext, ProviderMetaItem } from '../meta-sources';
import { listTeoZones, teoOpsForDomain } from '../../origin-group-broker';

/**
 * EdgeOne 站点的候选值。
 *
 * 复用 DNSPod 凭据时，DNSPod 注册的域名与 EdgeOne 站点没有对应关系，
 * 只能先用这对凭据列出可见站点，让用户显式选一个 zoneId。
 */
registerProviderMetaSource({
  source: 'edgeoneZones',
  providerType: 'tencenteo',
  async resolve(ctx: ProviderMetaContext): Promise<ProviderMetaItem[]> {
    const zones = await listTeoZones(ctx.domainId, { siteType: ctx.params?.siteType });
    return zones.map((zone) => ({ value: zone.zoneId, label: zone.zoneName || zone.zoneId }));
  },
});

/**
 * EdgeOne 源站组的候选值。
 *
 * 与能力层共用 `teoOpsForDomain`：EdgeOne 账号用 third_id 与账号配置的站点类型；
 * DNSPod 账号则用同一对腾讯云密钥 + 显式声明的 siteType / zoneId。
 * 非这两类账号会抛出可读错误，由路由转成 502，而不是静默返回空列表。
 */
registerProviderMetaSource({
  source: 'originGroups',
  providerType: 'tencenteo',
  async resolve(ctx: ProviderMetaContext): Promise<ProviderMetaItem[]> {
    const { ops } = await teoOpsForDomain(ctx.domainId, {
      siteType: ctx.params?.siteType,
      zoneId: ctx.params?.zoneId,
    });
    const groups = await ops.list({ limit: 100 });
    return groups.map((group) => ({
      value: group.groupId,
      label: group.name || group.groupId,
      records: group.records.length,
      references: group.references.length,
    }));
  },
});
