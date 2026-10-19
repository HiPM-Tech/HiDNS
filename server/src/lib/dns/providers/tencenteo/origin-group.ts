/**
 * EdgeOne 源站组：收敛计划（纯函数）。
 * 设计依据：docs/WORKFLOW_ENGINE_DESIGN.md §3.7.3 / §3.7.9
 *
 * DTO、地址族判定、内网校验、摘要序列化已下沉到 `../../origin-group-core`，
 * 供腾讯云与虚拟提供商共用。本文件只保留"整组收敛"这一腾讯云特有语义，
 * 并原样再导出核心符号，保证既有 import 路径不变。
 *
 * 本文件**不发起任何 API 请求**，只做形态映射与 diff，便于穷举测试。
 */

import {
  assertPublicTarget,
  stableStringify,
  type OriginGroup,
  type OriginRecord,
  type OriginRecordType,
} from '../../origin-group-core';

export {
  OriginGroupError,
  assertPublicTarget,
  describeReferences,
  hasIrrecoverableData,
  ipFamily,
  isIpLiteral,
  isPrivateAddress,
  recordFingerprint,
  stableStringify,
} from '../../origin-group-core';
export type {
  OriginGroup,
  OriginRecord,
  OriginRecordType,
  OriginReference,
} from '../../origin-group-core';

export interface CollapseTarget {
  record: string;
  type: OriginRecordType;
  weight?: number;
}

export interface CollapsePlan {
  groupId: string;
  collapsedFrom: number;
  target: CollapseTarget;
  removed: OriginRecord[];
  preservedReferences: OriginGroup['references'];
  digest: string;
  /** 目标与当前唯一一条完全相同 → 幂等跳过 */
  noop: boolean;
}

/** 差异摘要：提交时重算，与预览不一致即拒绝（§3.7.9.2） */
export function computePlanDigest(parts: {
  groupId: string;
  target: CollapseTarget;
  removed: OriginRecord[];
}): string {
  const removedKey = parts.removed
    .map((r) => [r.recordId ?? '', r.record, r.type, String(r.weight ?? '')].join('|'))
    .sort()
    .join(';');
  return stableStringify({ g: parts.groupId, t: parts.target, r: removedKey });
}

/**
 * 收敛计划：整组 → 单一目标。
 * - removed 逐条列出被销毁记录（F3）
 * - 仅一条且与目标一致 → noop（F7）
 * - 目标预检（F5）
 */
export function planCollapse(group: OriginGroup, target: CollapseTarget): CollapsePlan {
  assertPublicTarget(target);

  const noop =
    group.records.length === 1 &&
    group.records[0].record === target.record &&
    group.records[0].type === target.type;

  const removed = noop ? [] : [...group.records];
  const digest = computePlanDigest({ groupId: group.groupId, target, removed });

  return {
    groupId: group.groupId,
    collapsedFrom: group.records.length,
    target,
    removed,
    preservedReferences: group.references,
    digest,
    noop,
  };
}

/** 收敛后的目标 Records 数组：恰好一条，且不带 weight（F6） */
export function buildCollapsedRecords(target: CollapseTarget): OriginRecord[] {
  return [{ record: target.record, type: target.type }];
}
