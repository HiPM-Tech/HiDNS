import { DnsProviderService } from '../../../../service/dns-provider-service';
import { DomainOperations } from '../../../../db/bal/business-adapter';
import { VirtualAdapter } from './adapter';
import type { ProviderExtraCapability, ProviderActionHandler } from '../extra-types';
import { OriginGroupError } from '../../origin-group-core';
import {
  applySyncSet,
  planSyncSet,
  selectGroupsForDomain,
  type AddressUpdate,
  type GroupSyncOptions,
} from '../../origin-group-sync';
import type { OriginGroupClient } from '../tencenteo/origin-group-client';

/**
 * 虚拟提供商的源站组能力。
 *
 * 动作形状与 `ext.tencenteo.originGroup.*` 对齐，但语义是"按地址族同步"而非"整组收敛"：
 * DDNS 改了域名的 A/AAAA 之后，这里只替换对应地址族的源站记录，
 * 其余记录原样保留。一个域名可扇出到多个源站组，A 与 AAAA 可一次写完。
 */

async function opsFor(args: Record<string, unknown>): Promise<OriginGroupClient> {
  const domainId = Number(args.domainId);
  if (!Number.isFinite(domainId) || domainId <= 0) {
    throw new OriginGroupError('INVALID_ARGS', '缺少 domainId');
  }
  const domain = (await DomainOperations.getById(domainId)) as unknown as
    | { id: number; name: string; account_id: number; third_id?: string }
    | undefined;
  if (!domain) throw new OriginGroupError('DOMAIN_NOT_FOUND', '域名不存在');

  const adapter = await DnsProviderService.getAdapterByAccount(Number(domain.account_id));
  if (!(adapter instanceof VirtualAdapter)) {
    throw new OriginGroupError('PROVIDER_MISMATCH', '该域名的提供商不是虚拟提供商');
  }
  adapter.setZoneInfo(String(domain.third_id ?? ''), String(domain.name ?? ''));
  return adapter.originGroups();
}

function readAddressUpdate(args: Record<string, unknown>): AddressUpdate {
  const update: AddressUpdate = {};
  const v4 = String(args.v4 ?? '').trim();
  const v6 = String(args.v6 ?? '').trim();
  if (v4) update.v4 = v4;
  if (v6) update.v6 = v6;
  if (!update.v4 && !update.v6) {
    throw new OriginGroupError('INVALID_UPDATE', '需要 v4 或 v6 至少一项');
  }
  return update;
}

function readOptions(args: Record<string, unknown>): GroupSyncOptions {
  const onPartial = String(args.onPartial ?? '').trim();
  return {
    addIfMissing: args.addIfMissing === true,
    allowMultiple: args.allowMultiple === true,
    preserveRecordId: args.preserveRecordId !== false,
    onPartial: onPartial === 'apply' ? 'apply' : 'reject',
  };
}

/** 目标组：显式 groupIds 优先；否则按 domainName 在引用方里扇出 */
async function resolveGroupIds(ops: OriginGroupClient, args: Record<string, unknown>): Promise<string[]> {
  const raw = args.groupIds;
  const explicit = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === 'string'
      ? raw.split(',').map((item) => item.trim())
      : [];
  const cleaned = explicit.map((item) => item.trim()).filter(Boolean);
  if (cleaned.length > 0) return cleaned;

  const domainName = String(args.domainName ?? '').trim();
  if (domainName) {
    const groups = await ops.list({ limit: 1000 });
    return selectGroupsForDomain(groups, domainName).map((group) => group.groupId);
  }
  throw new OriginGroupError('NO_TARGET_GROUP', '需要 groupIds 或 domainName 指定目标源站组');
}

const handlers: Record<string, ProviderActionHandler> = {
  'ext.virtual.originGroup.list': async (args) => {
    const ops = await opsFor(args);
    return ops.list({ limit: 1000 });
  },

  'ext.virtual.originGroup.get': async (args) => {
    const ops = await opsFor(args);
    const group = await ops.get(String(args.groupId ?? ''));
    if (!group) throw new OriginGroupError('GROUP_NOT_FOUND', '源站组不存在');
    return group;
  },

  'ext.virtual.originGroup.planSync': async (args) => {
    const ops = await opsFor(args);
    const groupIds = await resolveGroupIds(ops, args);
    const set = await planSyncSet(ops, {
      groupIds,
      update: readAddressUpdate(args),
      options: readOptions(args),
    });
    return {
      digest: set.digest,
      hasBlocked: set.hasBlocked,
      plans: set.plans,
      applicable: set.applicable.map((plan) => plan.groupId),
    };
  },

  'ext.virtual.originGroup.sync': async (args) => {
    const ops = await opsFor(args);
    const groupIds = await resolveGroupIds(ops, args);
    const diffDigest = String(args.diffDigest ?? '');
    if (!diffDigest) throw new OriginGroupError('DIGEST_REQUIRED', '必须提供 diffDigest（先 planSync）');
    const { results, digest } = await applySyncSet(
      ops,
      { groupIds, update: readAddressUpdate(args), options: readOptions(args) },
      diffDigest,
    );
    return { digest, results };
  },
};

export const virtualOriginGroupCapability: ProviderExtraCapability = {
  name: 'ext.virtual.originGroup',
  label: 'provider.virtual_origin_group',
  actions: [
    {
      name: 'ext.virtual.originGroup.list',
      label: 'provider.virtual_origin_group_list',
      actionClass: 'ext.read',
      risk: 'low',
      service: 'records.read',
      dslVisible: true,
      params: [{ key: 'domainId', label: 'workflow.param.domain_id', type: 'number', required: true }],
    },
    {
      name: 'ext.virtual.originGroup.get',
      label: 'provider.virtual_origin_group_get',
      actionClass: 'ext.read',
      risk: 'low',
      service: 'records.read',
      dslVisible: true,
      params: [
        { key: 'domainId', label: 'workflow.param.domain_id', type: 'number', required: true },
        { key: 'groupId', label: 'workflow.param.group_id', type: 'text', required: true, source: 'virtualOriginGroups', sourceParams: ['domainId'] },
      ],
    },
    {
      name: 'ext.virtual.originGroup.planSync',
      label: 'provider.virtual_origin_group_plan_sync',
      actionClass: 'ext.read',
      risk: 'low',
      service: 'records.read',
      dslVisible: true,
      params: [
        { key: 'domainId', label: 'workflow.param.domain_id', type: 'number', required: true },
        { key: 'domainName', label: 'workflow.param.domain_name', type: 'text', required: false },
        { key: 'groupIds', label: 'workflow.param.group_ids', type: 'text', required: false },
        { key: 'v4', label: 'workflow.param.ipv4', type: 'text', required: false },
        { key: 'v6', label: 'workflow.param.ipv6', type: 'text', required: false },
        { key: 'addIfMissing', label: 'workflow.param.add_if_missing', type: 'boolean', required: false },
        { key: 'allowMultiple', label: 'workflow.param.allow_multiple', type: 'boolean', required: false },
        { key: 'onPartial', label: 'workflow.param.on_partial', type: 'select', required: false, options: ['reject', 'apply'] },
      ],
    },
    {
      name: 'ext.virtual.originGroup.sync',
      label: 'provider.virtual_origin_group_sync',
      actionClass: 'ext.write',
      risk: 'high',
      service: 'records.write',
      dslVisible: true,
      params: [
        { key: 'domainId', label: 'workflow.param.domain_id', type: 'number', required: true },
        { key: 'domainName', label: 'workflow.param.domain_name', type: 'text', required: false },
        { key: 'groupIds', label: 'workflow.param.group_ids', type: 'text', required: false },
        { key: 'v4', label: 'workflow.param.ipv4', type: 'text', required: false },
        { key: 'v6', label: 'workflow.param.ipv6', type: 'text', required: false },
        { key: 'addIfMissing', label: 'workflow.param.add_if_missing', type: 'boolean', required: false },
        { key: 'allowMultiple', label: 'workflow.param.allow_multiple', type: 'boolean', required: false },
        { key: 'onPartial', label: 'workflow.param.on_partial', type: 'select', required: false, options: ['reject', 'apply'] },
        { key: 'diffDigest', label: 'workflow.param.diff_digest', type: 'text', required: true },
      ],
    },
  ],
  handlers,
};
