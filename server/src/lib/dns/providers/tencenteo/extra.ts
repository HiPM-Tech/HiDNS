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
import { attachResolvedTarget } from '../../../resolved-target';
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
/**
 * 确认闸门的取值判定：接受真布尔与字符串两种写法。
 *
 * 编辑器内部统一用字符串存参数值，历史数据里 `collapse` 可能是 "true"；
 * 只判 `=== true` 会让界面已经勾上的工作流在运行期仍被拒。
 */
function isTrueFlag(value: unknown): boolean {
  return value === true || value === 'true';
}

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

/**
 * 把「这次解析到了哪个账号/站点」旁挂到返回值上（审计用，不进 DSL 可见返回值）。
 * 契约形态由入参决定：带 accountId 是新契约，只有 domainId 是旧形态。
 */
function withTarget<T>(value: T, ctx: TeoOps, args: Record<string, unknown>, groupId?: string): T {
  const accountRaw = args.accountId;
  const isNew = accountRaw !== undefined && accountRaw !== null && String(accountRaw).trim() !== '';
  return attachResolvedTarget(value, {
    contract: isNew ? 'v2' : 'v1-legacy',
    accountId: ctx.accountId,
    scopeId: ctx.zoneId,
    siteType: ctx.siteType,
    groupId,
  });
}

const handlers: Record<string, ProviderActionHandler> = {
  'ext.tencenteo.originGroup.list': async (args) => {
    const ctx = await teoOpsForArgs(args);
    return withTarget(await ctx.ops.list({}), ctx, args);
  },

  'ext.tencenteo.originGroup.get': async (args) => {
    const ctx = await loadGroup(args);
    return withTarget(ctx.group, ctx, args, ctx.group.groupId);
  },

  'ext.tencenteo.originGroup.plan': async (args) => {
    const ctx = await loadGroup(args);
    const { group, credentialSource, zoneId, siteType } = ctx;
    const target: CollapseTarget = {
      record: String(args.target ?? ''),
      type: 'IP_DOMAIN',
    };
    const plan = planCollapse(group, target, locationOf(ctx));
    return withTarget({
      ...plan,
      irrecoverable: hasIrrecoverableData(plan.removed),
      referenced: group.references.length > 0,
      referencing: describeReferences(group.references),
      // 让操作者在确认前就看到这次会用哪类账号的凭据、打的是哪个端点
      credentialSource,
      zoneId,
      siteType,
    }, ctx, args, group.groupId);
  },

  'ext.tencenteo.originGroup.replace': async (args) => {
    if (!isTrueFlag(args.collapse)) {
      throw new OriginGroupError('COLLAPSE_NOT_ACKNOWLEDGED', '必须显式声明 collapse: true');
    }
    const ctx = await loadGroup(args);
    const { group, ops, credentialSource, zoneId, siteType } = ctx;
    const target: CollapseTarget = {
      record: String(args.target ?? ''),
      type: 'IP_DOMAIN',
    };
    const plan = planCollapse(group, target, locationOf(ctx));

    if (plan.noop) {
      return withTarget({ skipped: true, reason: 'already-collapsed', plan, credentialSource, zoneId, siteType }, ctx, args, group.groupId);
    }

    // 被引用中的源站组不得整组覆盖：坍缩会立刻改变这些域名的回源行为。
    // 这是"写入前的最后一道闸门"，不依赖调用方自律。
    if (group.references.length > 0 && !isTrueFlag(args.acknowledgeReferenced)) {
      const names = describeReferences(group.references);
      const head = names.slice(0, 5).join('、');
      const tail = names.length > 5 ? ` 等 ${names.length} 项` : '';
      throw new OriginGroupError(
        'GROUP_REFERENCED',
        `源站组仍被 ${names.length} 个资源引用（${head}${tail}），整组覆盖会直接影响这些域名；如确需继续请显式传 acknowledgeReferenced: true`,
      );
    }

    if (hasIrrecoverableData(plan.removed) && !isTrueFlag(args.acknowledgeDataLoss)) {
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

    return withTarget(
      {
        collapsedFrom: plan.collapsedFrom,
        target,
        references: plan.preservedReferences,
        requestId: requestId ?? null,
        credentialSource,
        zoneId,
        siteType,
      },
      ctx,
      args,
      group.groupId,
    );
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
        { key: 'accountId', label: 'workflow.param.account_id', type: 'number', required: true, source: 'accounts', sourceQuery: { originGroup: 'true' } },
        { key: 'scopeId', label: 'workflow.param.scope_id', type: 'text', required: true, source: 'edgeoneZones', sourceParams: ['accountId'], sourceOptionalParams: ['siteType'], allowFreeInput: true },
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
        { key: 'accountId', label: 'workflow.param.account_id', type: 'number', required: true, source: 'accounts', sourceQuery: { originGroup: 'true' } },
        { key: 'scopeId', label: 'workflow.param.scope_id', type: 'text', required: true, source: 'edgeoneZones', sourceParams: ['accountId'], sourceOptionalParams: ['siteType'], allowFreeInput: true },
        { key: 'siteType', label: 'workflow.param.site_type', type: 'select', required: false, options: ['mainland', 'intl'] },
        { key: 'groupId', label: 'workflow.param.group_id', type: 'text', required: true, source: 'originGroups', sourceParams: ['accountId', 'scopeId'], sourceOptionalParams: ['siteType'], allowFreeInput: true },
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
        { key: 'accountId', label: 'workflow.param.account_id', type: 'number', required: true, source: 'accounts', sourceQuery: { originGroup: 'true' } },
        { key: 'scopeId', label: 'workflow.param.scope_id', type: 'text', required: true, source: 'edgeoneZones', sourceParams: ['accountId'], sourceOptionalParams: ['siteType'], allowFreeInput: true },
        { key: 'siteType', label: 'workflow.param.site_type', type: 'select', required: false, options: ['mainland', 'intl'] },
        { key: 'groupId', label: 'workflow.param.group_id', type: 'text', required: true, source: 'originGroups', sourceParams: ['accountId', 'scopeId'], sourceOptionalParams: ['siteType'], allowFreeInput: true },
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
        { key: 'accountId', label: 'workflow.param.account_id', type: 'number', required: true, source: 'accounts', sourceQuery: { originGroup: 'true' } },
        { key: 'scopeId', label: 'workflow.param.scope_id', type: 'text', required: true, source: 'edgeoneZones', sourceParams: ['accountId'], sourceOptionalParams: ['siteType'], allowFreeInput: true },
        { key: 'siteType', label: 'workflow.param.site_type', type: 'select', required: false, options: ['mainland', 'intl'] },
        { key: 'groupId', label: 'workflow.param.group_id', type: 'text', required: true, source: 'originGroups', sourceParams: ['accountId', 'scopeId'], sourceOptionalParams: ['siteType'], allowFreeInput: true },
        { key: 'target', label: 'workflow.param.target', type: 'text', required: true, hint: 'workflow.paramHint.target', validation: 'public-origin' },
        { key: 'diffDigest', label: 'workflow.param.diff_digest', type: 'text', required: true, hint: 'workflow.paramHint.diff_digest' },
        // 下面三个是写入前的确认闸门，handler 强制要求。
        // 之前没声明 = 界面上根本设不了，于是这个动作**永远**抛 COLLAPSE_NOT_ACKNOWLEDGED。
        { key: 'collapse', label: 'workflow.param.collapse', type: 'boolean', required: true, hint: 'workflow.paramHint.collapse', validation: 'must-be-true' },
        { key: 'acknowledgeReferenced', label: 'workflow.param.acknowledge_referenced', type: 'boolean', required: false, hint: 'workflow.paramHint.acknowledge_referenced' },
        { key: 'acknowledgeDataLoss', label: 'workflow.param.acknowledge_data_loss', type: 'boolean', required: false, hint: 'workflow.paramHint.acknowledge_data_loss' },
      ],
    },
  ],
  handlers,
};
