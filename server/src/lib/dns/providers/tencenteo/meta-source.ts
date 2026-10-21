import { registerProviderMetaSource, requireAccountId } from '../meta-sources';
import type { ProviderMetaContext, ProviderMetaItem } from '../meta-sources';
import { listTeoZonesByAccount, teoOpsForAccount } from './origin-group-context';

/**
 * EdgeOne 站点的候选值。
 *
 * 设计 §3.7.8：源站组按「账号 + 作用域」定位，因此本源的入参是 **accountId** 而不是 domainId。
 * 复用 DNSPod 凭据时，DNSPod 注册的域名与 EdgeOne 站点没有对应关系，
 * 只能先用这对凭据列出可见站点，让用户显式选一个作用域。
 */
registerProviderMetaSource({
  source: 'edgeoneZones',
  providerType: 'tencenteo',
  scope: 'account',
  async resolve(ctx: ProviderMetaContext): Promise<ProviderMetaItem[]> {
    const zones = await listTeoZonesByAccount(requireAccountId(ctx), { siteType: ctx.params?.siteType });
    return zones.map((zone) => ({ value: zone.zoneId, label: zone.zoneName || zone.zoneId }));
  },
});

/**
 * EdgeOne 源站组的候选值。
 *
 * 与能力层共用 `teoOpsForAccount`——候选源与动作必须同源，
 * 否则会出现「下拉里看得到、选中后运行期才 404」的错位。
 * 非这两类账号会抛出可读错误，由路由转成 502，而不是静默返回空列表。
 */
registerProviderMetaSource({
  source: 'originGroups',
  providerType: 'tencenteo',
  scope: 'account',
  async resolve(ctx: ProviderMetaContext): Promise<ProviderMetaItem[]> {
    const { ops } = await teoOpsForAccount(requireAccountId(ctx), {
      siteType: ctx.params?.siteType,
      zoneId: ctx.scopeId,
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
