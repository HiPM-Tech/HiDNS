import type { ProviderExtraCapability, ProviderActionHandler } from '../extra-types';
import {
  buildCollapsedRecords,
  describeReferences,
  hasIrrecoverableData,
  planCollapse,
  OriginGroupError,
  type CollapseLocation,
  type CollapseTarget,
  type OriginGroup,
} from './origin-group';
import { teoOpsForAccount, teoOpsForDomain, type TeoOps } from './origin-group-context';
import { authorizeTencenteoOriginGroup } from './origin-group-authorize';

/**
 * EdgeOne 源站组能力。
 *
 * 凭据解析（含"复用 DNSPod 账号的腾讯云凭据"）在同目录 `./origin-group-context`，
 * 站点级授权在 `./origin-group-authorize`；两者与编辑器的候选源共用同一份实现。
 */

/** 站点类型只对"复用 DNSPod 凭据"有意义；EdgeOne 账号会忽略它 */
function readSiteType(args: Record<string, unknown>): string | undefined {
  const value = String(args.siteType ?? '').trim();
  return value || undefined;
}

/** EdgeOne ZoneId，同样只在复用 DNSPod 凭据时需要 */
function readZoneId(args: Record<string, unknown>): string | undefined {
  const value = String(args.zoneId ?? '').trim();
  return value || undefined;
}

function teoOptions(args: Record<string, unknown>): { siteType?: string; zoneId?: string } {
  return { siteType: readSiteType(args), zoneId: readZoneId(args) };
}

/**
 * 把已解析的凭据上下文收敛成摘要用的位置。
 * 位置必须进摘要，否则同账号下不同站点的同名同内容组会让 plan/replace 的摘要撞车。
 */
function locationOf(ctx: TeoOps): CollapseLocation {
  return { accountId: ctx.accountId, scopeId: ctx.zoneId, siteType: ctx.siteType };
}

/**
 * 按入参形态选解析入口：新契约（accountId + scopeId）/ 旧形态（domainId）。
 * 双模式只在这一个地方分流——鉴权、摘要、候选源都依赖同一套定位语义。
 */
async function teoOpsForArgs(args: Record<string, unknown>): Promise<TeoOps> {
  const siteType = readSiteType(args);
  const accountRaw = args.accountId;
  const hasAccount = accountRaw !== undefined && accountRaw !== null && String(accountRaw).trim() !== '';
  if (hasAccount) {
    return teoOpsForAccount(Number(accountRaw), {
      siteType,
      zoneId: String(args.scopeId ?? '').trim() || undefined,
    });
  }
  return teoOpsForDomain(Number(args.domainId), { siteType, zoneId: readZoneId(args) });
}

async function loadGroup(args: Record<string, unknown>): Promise<TeoOps & { group: OriginGroup }> {
  const ctx = await teoOpsForArgs(args);
  const group = await ctx.ops.get(String(args.groupId ?? ''));
  if (!group) throw new OriginGroupError('GROUP_NOT_FOUND', '源站组不存在');
  return { ...ctx, group };
}

const handlers: Record<string, ProviderActionHandler> = {
  'ext.tencenteo.originGroup.list': async (args) => {
    const { ops } = await teoOpsForArgs(args);
    return ops.list({});
  },

  'ext.tencenteo.originGroup.get': async (args) => (await loadGroup(args)).group,

  'ext.tencenteo.originGroup.plan': async (args) => {
    const ctx = await loadGroup(args);
    const { group, credentialSource, zoneId, siteType } = ctx;
    const target: CollapseTarget = {
      record: String(args.target ?? ''),
      type: 'IP_DOMAIN',
    };
    const plan = planCollapse(group, target, locationOf(ctx));
    return {
      ...plan,
      irrecoverable: hasIrrecoverableData(plan.removed),
      referenced: group.references.length > 0,
      referencing: describeReferences(group.references),
      // 让操作者在确认前就看到这次会用哪类账号的凭据、打的是哪个端点
      credentialSource,
      zoneId,
      siteType,
    };
  },

  'ext.tencenteo.originGroup.replace': async (args) => {
    if (args.collapse !== true) {
      throw new OriginGroupError('COLLAPSE_NOT_ACKNOWLEDGED', '必须显式声明 collapse: true');
    }
    const ctx = await loadGroup(args);
    const { group, ops, credentialSource, zoneId, siteType } = ctx;
    const target: CollapseTarget = {
      record: String(args.target ?? ''),
      type: 'IP_DOMAIN',
    };
    const plan = planCollapse(group, target, locationOf(ctx));

    if (plan.noop) return { skipped: true, reason: 'already-collapsed', plan, credentialSource, zoneId, siteType };

    // 被引用中的源站组不得整组覆盖：坍缩会立刻改变这些域名的回源行为。
    // 这是"写入前的最后一道闸门"，不依赖调用方自律。
    if (group.references.length > 0 && args.acknowledgeReferenced !== true) {
      const names = describeReferences(group.references);
      const head = names.slice(0, 5).join('、');
      const tail = names.length > 5 ? ` 等 ${names.length} 项` : '';
      throw new OriginGroupError(
        'GROUP_REFERENCED',
        `源站组仍被 ${names.length} 个资源引用（${head}${tail}），整组覆盖会直接影响这些域名；如确需继续请显式传 acknowledgeReferenced: true`,
      );
    }

    if (hasIrrecoverableData(plan.removed) && args.acknowledgeDataLoss !== true) {
      throw new OriginGroupError(
        'IRRECOVERABLE_DATA_LOSS',
        '被移除记录含对象存储私有参数，需 acknowledgeDataLoss: true',
      );
    }

    if (typeof args.diffDigest !== 'string' || args.diffDigest !== plan.digest) {
      throw new OriginGroupError('DIGEST_MISMATCH', 'diff 与预览不一致，请重新 plan');
    }

    // 复用上面已经解析好的 ops：再调一次 opsFor 会为复用凭据的场景多发一次 DescribeZones
    const { requestId } = await ops.replace(group.groupId, buildCollapsedRecords(target));

    const after = await ops.get(group.groupId);
    const ok =
      after !== null &&
      after.records.length === 1 &&
      after.records[0].record === target.record;
    if (!ok) throw new OriginGroupError('VERIFY_FAILED', '写入后校验失败');

    return {
      collapsedFrom: plan.collapsedFrom,
      target,
      references: plan.preservedReferences,
      requestId: requestId ?? null,
      credentialSource,
      zoneId,
      siteType,
    };
  },
};

export const tencenteoOriginGroupCapability: ProviderExtraCapability = {
  name: 'ext.tencenteo.originGroup',
  label: 'provider.tencenteo_origin_group',
  // 源站组属于 EdgeOne 站点，不是域名资源：授权按"账号 + 站点"判定，不套域名写权限
  authorize: authorizeTencenteoOriginGroup,
  actions: [
    {
      name: 'ext.tencenteo.originGroup.list',
      label: 'workflow.action.tencenteo_origin_group_list',
      description: 'workflow.actionDesc.tencenteo_origin_group_list',
      actionClass: 'ext.read',
      risk: 'low',
      service: 'records.read',
      dslVisible: true,
      params: [
        // 设计 §3.7.8：源站组按「账号 + 作用域」定位，不再经域名中转。
        { key: 'accountId', label: 'workflow.param.account_id', type: 'number', required: true, source: 'accounts' },
        { key: 'scopeId', label: 'workflow.param.scope_id', type: 'text', required: true, source: 'edgeoneZones', sourceParams: ['accountId'], sourceOptionalParams: ['siteType'] },
        { key: 'siteType', label: 'workflow.param.site_type', type: 'select', required: false, options: ['mainland', 'intl'] },
      ],
    },
    {
      name: 'ext.tencenteo.originGroup.get',
      label: 'workflow.action.tencenteo_origin_group_get',
      description: 'workflow.actionDesc.tencenteo_origin_group_get',
      actionClass: 'ext.read',
      risk: 'low',
      service: 'records.read',
      dslVisible: true,
      params: [
        // 设计 §3.7.8：源站组按「账号 + 作用域」定位，不再经域名中转。
        { key: 'accountId', label: 'workflow.param.account_id', type: 'number', required: true, source: 'accounts' },
        { key: 'scopeId', label: 'workflow.param.scope_id', type: 'text', required: true, source: 'edgeoneZones', sourceParams: ['accountId'], sourceOptionalParams: ['siteType'] },
        { key: 'siteType', label: 'workflow.param.site_type', type: 'select', required: false, options: ['mainland', 'intl'] },
        { key: 'groupId', label: 'workflow.param.group_id', type: 'text', required: true, source: 'originGroups', sourceParams: ['accountId', 'scopeId'], sourceOptionalParams: ['siteType'] },
      ],
    },
    {
      name: 'ext.tencenteo.originGroup.plan',
      label: 'workflow.action.tencenteo_origin_group_plan',
      description: 'workflow.actionDesc.tencenteo_origin_group_plan',
      actionClass: 'ext.read',
      risk: 'low',
      service: 'records.read',
      dslVisible: true,
      params: [
        // 设计 §3.7.8：源站组按「账号 + 作用域」定位，不再经域名中转。
        { key: 'accountId', label: 'workflow.param.account_id', type: 'number', required: true, source: 'accounts' },
        { key: 'scopeId', label: 'workflow.param.scope_id', type: 'text', required: true, source: 'edgeoneZones', sourceParams: ['accountId'], sourceOptionalParams: ['siteType'] },
        { key: 'siteType', label: 'workflow.param.site_type', type: 'select', required: false, options: ['mainland', 'intl'] },
        { key: 'groupId', label: 'workflow.param.group_id', type: 'text', required: true, source: 'originGroups', sourceParams: ['accountId', 'scopeId'], sourceOptionalParams: ['siteType'] },
        { key: 'target', label: 'workflow.param.target', type: 'text', required: true, hint: 'workflow.paramHint.target', validation: 'public-origin' },
      ],
    },
    {
      name: 'ext.tencenteo.originGroup.replace',
      label: 'workflow.action.tencenteo_origin_group_replace',
      description: 'workflow.actionDesc.tencenteo_origin_group_replace',
      actionClass: 'ext.write',
      risk: 'high',
      service: 'records.write',
      dslVisible: true,
      params: [
        // 设计 §3.7.8：源站组按「账号 + 作用域」定位，不再经域名中转。
        { key: 'accountId', label: 'workflow.param.account_id', type: 'number', required: true, source: 'accounts' },
        { key: 'scopeId', label: 'workflow.param.scope_id', type: 'text', required: true, source: 'edgeoneZones', sourceParams: ['accountId'], sourceOptionalParams: ['siteType'] },
        { key: 'siteType', label: 'workflow.param.site_type', type: 'select', required: false, options: ['mainland', 'intl'] },
        { key: 'groupId', label: 'workflow.param.group_id', type: 'text', required: true, source: 'originGroups', sourceParams: ['accountId', 'scopeId'], sourceOptionalParams: ['siteType'] },
        { key: 'target', label: 'workflow.param.target', type: 'text', required: true, hint: 'workflow.paramHint.target', validation: 'public-origin' },
        { key: 'diffDigest', label: 'workflow.param.diff_digest', type: 'text', required: true, hint: 'workflow.paramHint.diff_digest' },
      ],
    },
  ],
  handlers,
};
