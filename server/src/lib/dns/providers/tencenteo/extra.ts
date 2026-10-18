import { DnsProviderService } from '../../../../service/dns-provider-service';
import { TencenteoAdapter } from './adapter';
import type { ProviderExtraCapability, ProviderActionHandler } from '../extra-types';
import {
  buildCollapsedRecords,
  hasIrrecoverableData,
  planCollapse,
  OriginGroupError,
  type CollapseTarget,
  type OriginGroup,
} from './origin-group';

async function opsFor(args: Record<string, unknown>) {
  const accountId = Number(args.accountId);
  const scopeId = String(args.scopeId ?? '');
  if (!Number.isFinite(accountId) || !scopeId) {
    throw new OriginGroupError('INVALID_ARGS', '缺少 accountId 或 scopeId');
  }
  const adapter = await DnsProviderService.getAdapterByAccount(accountId);
  if (!(adapter instanceof TencenteoAdapter)) {
    throw new OriginGroupError('PROVIDER_MISMATCH', '该账号不是 EdgeOne 账号');
  }
  adapter.setZoneInfo(scopeId, '');
  return adapter.originGroups();
}

async function loadGroup(args: Record<string, unknown>): Promise<OriginGroup> {
  const ops = await opsFor(args);
  const group = await ops.get(String(args.groupId ?? ''));
  if (!group) throw new OriginGroupError('GROUP_NOT_FOUND', '源站组不存在');
  return group;
}

const handlers: Record<string, ProviderActionHandler> = {
  'ext.tencenteo.originGroup.list': async (args) => {
    const ops = await opsFor(args);
    return ops.list({});
  },

  'ext.tencenteo.originGroup.get': async (args) => loadGroup(args),

  'ext.tencenteo.originGroup.plan': async (args) => {
    const group = await loadGroup(args);
    const target: CollapseTarget = {
      record: String(args.target ?? ''),
      type: 'IP_DOMAIN',
    };
    const plan = planCollapse(group, target);
    return { ...plan, irrecoverable: hasIrrecoverableData(plan.removed) };
  },

  'ext.tencenteo.originGroup.replace': async (args) => {
    if (args.collapse !== true) {
      throw new OriginGroupError('COLLAPSE_NOT_ACKNOWLEDGED', '必须显式声明 collapse: true');
    }
    const group = await loadGroup(args);
    const target: CollapseTarget = {
      record: String(args.target ?? ''),
      type: 'IP_DOMAIN',
    };
    const plan = planCollapse(group, target);

    if (plan.noop) return { skipped: true, reason: 'already-collapsed', plan };

    if (hasIrrecoverableData(plan.removed) && args.acknowledgeDataLoss !== true) {
      throw new OriginGroupError(
        'IRRECOVERABLE_DATA_LOSS',
        '被移除记录含对象存储私有参数，需 acknowledgeDataLoss: true',
      );
    }

    if (typeof args.diffDigest !== 'string' || args.diffDigest !== plan.digest) {
      throw new OriginGroupError('DIGEST_MISMATCH', 'diff 与预览不一致，请重新 plan');
    }

    const ops = await opsFor(args);
    await ops.replace(group.groupId, buildCollapsedRecords(target));

    const after = await ops.get(group.groupId);
    const ok =
      after !== null &&
      after.records.length === 1 &&
      after.records[0].record === target.record;
    if (!ok) throw new OriginGroupError('VERIFY_FAILED', '写入后校验失败');

    return { collapsedFrom: plan.collapsedFrom, target, references: plan.preservedReferences };
  },
};

export const tencenteoOriginGroupCapability: ProviderExtraCapability = {
  name: 'ext.tencenteo.originGroup',
  label: 'provider.tencenteo.origin_group',
  actions: [
    {
      name: 'ext.tencenteo.originGroup.list',
      label: 'provider.tencenteo.origin_group_list',
      actionClass: 'ext.read',
      risk: 'low',
      service: 'records.read',
      dslVisible: true,
      params: [
        { key: 'accountId', label: 'workflow.param.account_id', type: 'number', required: true },
        { key: 'scopeId', label: 'workflow.param.scope_id', type: 'text', required: true },
      ],
    },
    {
      name: 'ext.tencenteo.originGroup.get',
      label: 'provider.tencenteo.origin_group_get',
      actionClass: 'ext.read',
      risk: 'low',
      service: 'records.read',
      dslVisible: true,
      params: [
        { key: 'accountId', label: 'workflow.param.account_id', type: 'number', required: true },
        { key: 'scopeId', label: 'workflow.param.scope_id', type: 'text', required: true },
        { key: 'groupId', label: 'workflow.param.group_id', type: 'text', required: true },
      ],
    },
    {
      name: 'ext.tencenteo.originGroup.plan',
      label: 'provider.tencenteo.origin_group_plan',
      actionClass: 'ext.read',
      risk: 'low',
      service: 'records.read',
      dslVisible: true,
      params: [
        { key: 'accountId', label: 'workflow.param.account_id', type: 'number', required: true },
        { key: 'scopeId', label: 'workflow.param.scope_id', type: 'text', required: true },
        { key: 'groupId', label: 'workflow.param.group_id', type: 'text', required: true },
        { key: 'target', label: 'workflow.param.target', type: 'text', required: true },
      ],
    },
    {
      name: 'ext.tencenteo.originGroup.replace',
      label: 'provider.tencenteo.origin_group_replace',
      actionClass: 'ext.write',
      risk: 'high',
      service: 'records.write',
      dslVisible: true,
      params: [
        { key: 'accountId', label: 'workflow.param.account_id', type: 'number', required: true },
        { key: 'scopeId', label: 'workflow.param.scope_id', type: 'text', required: true },
        { key: 'groupId', label: 'workflow.param.group_id', type: 'text', required: true },
        { key: 'target', label: 'workflow.param.target', type: 'text', required: true },
        { key: 'diffDigest', label: 'workflow.param.diff_digest', type: 'text', required: true },
      ],
    },
  ],
  handlers,
};