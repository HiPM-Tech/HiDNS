import { isIP } from 'node:net';

/**
 * 源站组通用核心：DTO、地址族判定、内网校验、摘要。
 *
 * 本文件**不依赖任何具体提供商**，也不发起请求。
 * 腾讯云 EdgeOne 与虚拟提供商共用同一套 DTO，避免两家各写一份导致语义漂移。
 * 设计依据：docs/WORKFLOW_ENGINE_DESIGN.md §3.7.3 / §3.7.9
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

export interface OriginReference {
  type: string;
  id: string;
  name?: string;
  zoneId?: string;
  zoneName?: string;
}

export interface OriginGroup {
  groupId: string;
  name: string;
  type: 'GENERAL' | 'HTTP';
  hostHeader?: string;
  records: OriginRecord[];
  references: OriginReference[];
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

/**
 * 内网/保留地址判定。
 * - IPv4：10/8、127/8、192.168/16、169.254/16、0/8、100.64/10（CGNAT）、172.16/12
 * - IPv6：::1、::、fe80::/10（链路本地）、fec0::/10（站点本地）、fc00::/7（唯一本地）
 */
const PRIVATE_V4 =
  /^(10\.|127\.|192\.168\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[01])\.)/;
const PRIVATE_V6 = /^(::1$|::$|fe80:|fec0:|f[cd][0-9a-f]{2}:)/i;

/** 地址族：4 / 6 / 0（不是 IP 字面量） */
export function ipFamily(value: string): 4 | 6 | 0 {
  const trimmed = String(value ?? '').trim().replace(/^\[(.*)\]$/, '$1');
  const family = isIP(trimmed);
  return family === 4 || family === 6 ? family : 0;
}

/** 是否 IP 字面量（用于区分"IP 源站"与"域名源站"） */
export function isIpLiteral(value: string): boolean {
  return ipFamily(value) !== 0;
}

export function isPrivateAddress(value: string): boolean {
  const trimmed = String(value ?? '').trim().replace(/^\[(.*)\]$/, '$1');
  if (ipFamily(trimmed) === 4) return PRIVATE_V4.test(trimmed);
  if (ipFamily(trimmed) === 6) return PRIVATE_V6.test(trimmed);
  return false;
}

/** 目标值预检：内网 / 回环 / 本地名一律拒绝（§3.7.9.5.1） */
export function assertPublicTarget(target: { record: string; type: OriginRecordType }): void {
  const value = String(target.record ?? '').trim();
  if (!value) throw new OriginGroupError('INVALID_TARGET', '目标源站为空');
  if (target.type === 'AWS_S3') {
    throw new OriginGroupError('UNSUPPORTED_TARGET_TYPE', '不支持以对象存储源站作为收敛目标');
  }
  if (isPrivateAddress(value)) {
    throw new OriginGroupError('INTERNAL_ADDRESS', `拒绝内网/回环源站: ${value}`);
  }
  const lower = value.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.local')) {
    throw new OriginGroupError('INTERNAL_ADDRESS', `拒绝本地主机: ${value}`);
  }
}

/** 稳定序列化：键排序，保证同一对象在不同调用间得到同一字符串 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

/**
 * 被销毁记录中是否含不可重建数据。
 * `privateParameters` 必须是"非空对象"：真实 API 对无私有参数的记录返回 `[]`，
 * 以 `Boolean()` 判定会让本函数对任意普通记录恒为 true。
 */
export function hasIrrecoverableData(records: OriginRecord[]): boolean {
  return records.some((r) => {
    if (r.type === 'AWS_S3') return true;
    if (r.private === true) return true;
    const params = r.privateParameters;
    return params !== undefined && params !== null && Object.keys(params).length > 0;
  });
}

/** 引用方的人类可读清单：写前必须让操作者看清"谁在用这个组" */
export function describeReferences(references: OriginReference[]): string[] {
  return references.map((ref) => {
    const label = ref.name || ref.id || '(未知)';
    return ref.type ? `${label}[${ref.type}]` : label;
  });
}

/** 记录的身份指纹：用于摘要，不含私有参数明文 */
export function recordFingerprint(record: OriginRecord): string {
  return [record.recordId ?? '', record.record, record.type, String(record.weight ?? '')].join('|');
}


