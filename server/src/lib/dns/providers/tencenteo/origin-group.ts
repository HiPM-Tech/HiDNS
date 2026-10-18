/**
 * EdgeOne 源站组：DTO 与收敛计划（纯函数）。
 * 设计依据：docs/WORKFLOW_ENGINE_DESIGN.md §3.7.3 / §3.7.9
 *
 * 本文件**不发起任何 API 请求**，只做形态映射与 diff，便于穷举测试。
 */

export type OriginRecordType = 'IP_DOMAIN' | 'AWS_S3';

export interface OriginRecord {
  recordId?: string;
  record: string;
  type: OriginRecordType;
  weight?: number;
  private?: boolean;
  privateParameters?: Record<string, string>;
}

export interface OriginGroup {
  groupId: string;
  name: string;
  type: 'GENERAL' | 'HTTP';
  hostHeader?: string;
  records: OriginRecord[];
  references: Array<{ type: string; id: string; name?: string }>;
}

export class OriginGroupError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OriginGroupError';
  }
}

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

const PRIVATE_V4 = /^(10\.|127\.|192\.168\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
const PRIVATE_V6 = /^(::1$|::$|fe80:|fc|fd)/i;

/** 目标值预检：内网 / 回环一律拒绝（§3.7.9.5.1） */
export function assertPublicTarget(target: CollapseTarget): void {
  const value = target.record.trim();
  if (!value) throw new OriginGroupError('INVALID_TARGET', '目标源站为空');
  if (target.type === 'AWS_S3') {
    throw new OriginGroupError('UNSUPPORTED_TARGET_TYPE', '不支持以对象存储源站作为收敛目标');
  }
  if (PRIVATE_V4.test(value) || PRIVATE_V6.test(value)) {
    throw new OriginGroupError('INTERNAL_ADDRESS', `拒绝内网/回环源站: ${value}`);
  }
  if (value === 'localhost' || value.endsWith('.local')) {
    throw new OriginGroupError('INTERNAL_ADDRESS', `拒绝本地主机: ${value}`);
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
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

/** 被销毁记录中是否含不可重建数据（F4） */
export function hasIrrecoverableData(records: OriginRecord[]): boolean {
  return records.some((r) => r.type === 'AWS_S3' || r.private === true || Boolean(r.privateParameters));
}