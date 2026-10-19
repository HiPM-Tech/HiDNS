import type { ProviderExtraCapability, ProviderActionHandler } from '../extra-types';
import {
  buildCollapsedRecords,
  describeReferences,
  hasIrrecoverableData,
  planCollapse,
  OriginGroupError,
  type CollapseTarget,
  type OriginGroup,
} from './origin-group';
import { teoOpsForDomain, type TeoOps } from './teo-ops';

/**
 * EdgeOne 源站组能力。
 *
 * 鉴权解析（含"复用 DNSPod 账号的腾讯云凭据"）在 `./teo-ops` 里，
 * 与编辑器的候选源共用同一份实现，避免两处各写一遍。
 */

async function loadGroup(args: Record<string, unknown>): Promise<TeoOps & { group: OriginGroup }> {
  const ctx = await teoOpsForDomain(Number(args.domainId));
  const group = await ctx.ops.get(String(args.groupId ?? ''));
  if (!group) throw new OriginGroupError('GROUP_NOT_FOUND', '源站组不存在');
  return { ...ctx, group };
}

const handlers: Record<string, ProviderActionHandler> = {
  'ext.tencenteo.originGroup.list': async (args) => {
    const { ops } = await teoOpsForDomain(Number(args.domainId));
    return ops.list({});
  },

  'ext.tencenteo.originGroup.get': async (args) => (await loadGroup(args)).group,

  'ext.tencenteo.originGroup.plan': async (args) => {
    const { group, credentialSource, zoneId } = await loadGroup(args);
    const target: CollapseTarget = {
      record: String(args.target ?? ''),
      type: 'IP_DOMAIN',
    };
    const plan = planCollapse(group, target);
    return {
      ...plan,
      irrecoverable: hasIrrecoverableData(plan.removed),
      referenced: group.references.length > 0,
      referencing: describeReferences(group.references),
      // 让操作者在确认前就看到这次会用哪类账号的凭据
      credentialSource,
      zoneId,
    };
  },

  'ext.tencenteo.originGroup.replace': async (args) => {
    if (args.collapse !== true) {
      throw new OriginGroupError('COLLAPSE_NOT_ACKNOWLEDGED', '必须显式声明 collapse: true');
    }
    const { group, ops, credentialSource, zoneId } = await loadGroup(args);
    const target: CollapseTarget = {
      record: String(args.target ?? ''),
      type: 'IP_DOMAIN',
    };
    const plan = planCollapse(group, target);

    if (plan.noop) return { skipped: true, reason: 'already-collapsed', plan, credentialSource, zoneId };

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
    };
  },
};

export const tencenteoOriginGroupCapability: ProviderExtraCapability = {
  name: 'ext.tencenteo.originGroup',
  label: 'provider.tencenteo_origin_group',
  actions: [
    {
      name: 'ext.tencenteo.originGroup.list',
      label: 'provider.tencenteo_origin_group_list',
      actionClass: 'ext.read',
      risk: 'low',
      service: 'records.read',
      dslVisible: true,
      params: [
        { key: 'domainId', label: 'workflow.param.domain_id', type: 'number', required: true },
      ],
    },
    {
      name: 'ext.tencenteo.originGroup.get',
      label: 'provider.tencenteo_origin_group_get',
      actionClass: 'ext.read',
      risk: 'low',
      service: 'records.read',
      dslVisible: true,
      params: [
        { key: 'domainId', label: 'workflow.param.domain_id', type: 'number', required: true },
        { key: 'groupId', label: 'workflow.param.group_id', type: 'text', required: true, source: 'originGroups', sourceParams: ['domainId'] },
      ],
    },
    {
      name: 'ext.tencenteo.originGroup.plan',
      label: 'provider.tencenteo_origin_group_plan',
      actionClass: 'ext.read',
      risk: 'low',
      service: 'records.read',
      dslVisible: true,
      params: [
        { key: 'domainId', label: 'workflow.param.domain_id', type: 'number', required: true },
        { key: 'groupId', label: 'workflow.param.group_id', type: 'text', required: true, source: 'originGroups', sourceParams: ['domainId'] },
        { key: 'target', label: 'workflow.param.target', type: 'text', required: true },
      ],
    },
    {
      name: 'ext.tencenteo.originGroup.replace',
      label: 'provider.tencenteo_origin_group_replace',
      actionClass: 'ext.write',
      risk: 'high',
      service: 'records.write',
      dslVisible: true,
      params: [
        { key: 'domainId', label: 'workflow.param.domain_id', type: 'number', required: true },
        { key: 'groupId', label: 'workflow.param.group_id', type: 'text', required: true, source: 'originGroups', sourceParams: ['domainId'] },
        { key: 'target', label: 'workflow.param.target', type: 'text', required: true },
        { key: 'diffDigest', label: 'workflow.param.diff_digest', type: 'text', required: true },
      ],
    },
  ],
  handlers,
};
