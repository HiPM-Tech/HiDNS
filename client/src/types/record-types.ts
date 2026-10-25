// DNS record types - mirrored from server/src/lib/dns/record-types.ts
// Keep in sync when adding new record types

export type RecordType =
  // ── 基础记录 ──────────────────────────────
  | 'A' | 'NS' | 'CNAME' | 'SOA' | 'PTR' | 'MX' | 'TXT' | 'AAAA'
  // ── 较少使用但有效 ────────────────────────
  | 'WKS' | 'HINFO' | 'MINFO' | 'RP' | 'AFSDB' | 'X25' | 'ISDN' | 'RT'
  | 'PX' | 'GPOS'
  // ── 特殊用途 ──────────────────────────────
  | 'LOC' | 'SRV' | 'NAPTR' | 'KX' | 'DNAME' | 'HIP'
  | 'DHCID' | 'CSYNC' | 'ZONEMD'
  // ── 安全 / DNSSEC ─────────────────────────
  | 'SIG' | 'KEY' | 'CERT' | 'DS' | 'SSHFP' | 'IPSECKEY'
  | 'RRSIG' | 'NSEC' | 'DNSKEY' | 'TLSA' | 'OPENPGPKEY'
  | 'NSEC3' | 'NSEC3PARAM' | 'TALINK' | 'CDS' | 'CDNSKEY'
  | 'SMIMEA' | 'TA' | 'TKEY' | 'TSIG'
  | 'CAA'
  // ── 现代服务绑定 ──────────────────────────
  | 'SVCB' | 'HTTPS'
  // ── ILNP ──────────────────────────────────
  | 'NID' | 'L32' | 'L64' | 'LP'
  // ── 硬件地址 ──────────────────────────────
  | 'EUI48' | 'EUI64'
  // ── 其它标准 RFC ─────────────────────────
  | 'EID' | 'NIMLOC' | 'ATMA'
  | 'URI'
  | 'AVC' | 'DOA' | 'AMTRELAY' | 'RESINFO'
  | 'WALLET' | 'CLA' | 'IPN'
  | 'DSYNC' | 'HHIT' | 'BRID' | 'NXNAME';

export type ValueType = 'ipv4' | 'ipv6' | 'hostname' | 'text';

export interface ExtraFieldDef {
  key: string;
  label: string;
  dataType: 'string' | 'number';
  required: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  defaultValue?: string | number;
}

export interface RecordTypeDef {
  type: RecordType;
  label: string;
  valueType: ValueType;
  extraFields?: ExtraFieldDef[];
}

export const DNS_RECORD_DEFS: Record<RecordType, RecordTypeDef> = {
  // ── 基础记录 ──────────────────────────────
  A:       { type: 'A',    label: 'A',    valueType: 'ipv4' },
  NS:      { type: 'NS',   label: 'NS',   valueType: 'hostname' },
  CNAME:   { type: 'CNAME',label: 'CNAME',valueType: 'hostname' },
  SOA:     { type: 'SOA',  label: 'SOA',  valueType: 'text' },
  PTR:     { type: 'PTR',  label: 'PTR',  valueType: 'hostname' },
  MX:      { type: 'MX',   label: 'MX',   valueType: 'hostname', extraFields: [
    { key: 'mx', label: 'Priority', dataType: 'number', required: true, min: 0, max: 65535, defaultValue: 10 },
  ]},
  TXT:     { type: 'TXT',  label: 'TXT',  valueType: 'text' },
  AAAA:    { type: 'AAAA', label: 'AAAA', valueType: 'ipv6' },

  // ── 较少使用但有效 ────────────────────────
  WKS:     { type: 'WKS',  label: 'WKS',  valueType: 'text' },
  HINFO:   { type: 'HINFO',label: 'HINFO',valueType: 'text' },
  MINFO:   { type: 'MINFO',label: 'MINFO',valueType: 'text' },
  RP:      { type: 'RP',   label: 'RP',   valueType: 'text' },
  AFSDB:   { type: 'AFSDB',label: 'AFSDB',valueType: 'hostname' },
  X25:     { type: 'X25',  label: 'X25',  valueType: 'text' },
  ISDN:    { type: 'ISDN', label: 'ISDN', valueType: 'text' },
  RT:      { type: 'RT',   label: 'RT',   valueType: 'hostname' },
  PX:      { type: 'PX',   label: 'PX',   valueType: 'text' },
  GPOS:    { type: 'GPOS', label: 'GPOS', valueType: 'text' },

  // ── 特殊用途 ──────────────────────────────
  LOC:     { type: 'LOC',  label: 'LOC',  valueType: 'text' },
  SRV:     { type: 'SRV',  label: 'SRV',  valueType: 'hostname', extraFields: [
    { key: 'priority', label: 'Priority', dataType: 'number', required: true, min: 0, max: 65535, defaultValue: 10 },
    { key: 'weight',   label: 'Weight',   dataType: 'number', required: true, min: 0, max: 65535, defaultValue: 10 },
    { key: 'port',     label: 'Port',     dataType: 'number', required: true, min: 1, max: 65535 },
  ]},
  NAPTR:   { type: 'NAPTR',label: 'NAPTR',valueType: 'text' },
  KX:      { type: 'KX',   label: 'KX',   valueType: 'hostname' },
  DNAME:   { type: 'DNAME',label: 'DNAME',valueType: 'hostname' },
  HIP:     { type: 'HIP',  label: 'HIP',  valueType: 'text' },
  DHCID:   { type: 'DHCID',label: 'DHCID',valueType: 'text' },
  CSYNC:   { type: 'CSYNC',label: 'CSYNC',valueType: 'text' },
  ZONEMD:  { type: 'ZONEMD',label:'ZONEMD',valueType: 'text' },

  // ── 安全 / DNSSEC ─────────────────────────
  SIG:      { type: 'SIG',    label: 'SIG',    valueType: 'text' },
  KEY:      { type: 'KEY',    label: 'KEY',    valueType: 'text' },
  CERT:     { type: 'CERT',   label: 'CERT',   valueType: 'text', extraFields: [
    { key: 'certType',  label: 'CertType',  dataType: 'number', required: true, min: 0, max: 65535 },
    { key: 'keyTag',    label: 'KeyTag',    dataType: 'number', required: true, min: 0, max: 65535 },
    { key: 'algorithm', label: 'Algorithm', dataType: 'number', required: true, min: 0, max: 255 },
  ]},
  DS:       { type: 'DS',     label: 'DS',     valueType: 'text', extraFields: [
    { key: 'keyTag',      label: 'KeyTag',    dataType: 'number', required: true, min: 0, max: 65535 },
    { key: 'dsAlgorithm', label: 'Algorithm', dataType: 'number', required: true, min: 0, max: 255 },
    { key: 'digestType',  label: 'DigestType',dataType: 'number', required: true, min: 0, max: 255 },
  ]},
  SSHFP:    { type: 'SSHFP',  label: 'SSHFP',  valueType: 'text', extraFields: [
    { key: 'fpAlgorithm',     label: 'Algorithm',      dataType: 'number', required: true, min: 0, max: 255 },
    { key: 'fingerprintType', label: 'FingerprintType',dataType: 'number', required: true, min: 0, max: 255 },
  ]},
  IPSECKEY: { type: 'IPSECKEY',label:'IPSECKEY',valueType: 'text', extraFields: [
    { key: 'ipsecPriority',  label: 'Priority',   dataType: 'number', required: true, min: 0, max: 65535 },
    { key: 'gatewayType',    label: 'GatewayType',dataType: 'number', required: true, min: 0, max: 3 },
    { key: 'ipsecAlgorithm', label: 'Algorithm',  dataType: 'number', required: true, min: 0, max: 255 },
  ]},
  RRSIG:    { type: 'RRSIG',  label: 'RRSIG',  valueType: 'text' },
  NSEC:     { type: 'NSEC',   label: 'NSEC',   valueType: 'text' },
  DNSKEY:   { type: 'DNSKEY', label: 'DNSKEY', valueType: 'text', extraFields: [
    { key: 'dnskeyFlags',    label: 'Flags',    dataType: 'number', required: true, min: 0, max: 65535 },
    { key: 'protocol',       label: 'Protocol', dataType: 'number', required: true, min: 0, max: 255, defaultValue: 3 },
    { key: 'dnskeyAlgorithm',label:'Algorithm', dataType: 'number', required: true, min: 0, max: 255 },
  ]},
  TLSA:     { type: 'TLSA',   label: 'TLSA',   valueType: 'text', extraFields: [
    { key: 'usage',        label: 'Usage',        dataType: 'number', required: true, min: 0, max: 255 },
    { key: 'selector',     label: 'Selector',     dataType: 'number', required: true, min: 0, max: 255 },
    { key: 'matchingType', label: 'MatchingType', dataType: 'number', required: true, min: 0, max: 255 },
  ]},
  OPENPGPKEY:{type:'OPENPGPKEY',label:'OPENPGPKEY',valueType:'text'},
  NSEC3:        { type: 'NSEC3',    label: 'NSEC3',    valueType: 'text' },
  NSEC3PARAM:   { type: 'NSEC3PARAM',label:'NSEC3PARAM',valueType:'text' },
  TALINK:       { type: 'TALINK',   label: 'TALINK',   valueType: 'text' },
  CDS:          { type: 'CDS',      label: 'CDS',      valueType: 'text' },
  CDNSKEY:      { type: 'CDNSKEY',  label: 'CDNSKEY',  valueType: 'text' },
  SMIMEA:       { type: 'SMIMEA',   label: 'SMIMEA',   valueType: 'text', extraFields: [
    { key: 'usage',        label: 'Usage',        dataType: 'number', required: true, min: 0, max: 255 },
    { key: 'selector',     label: 'Selector',     dataType: 'number', required: true, min: 0, max: 255 },
    { key: 'matchingType', label: 'MatchingType', dataType: 'number', required: true, min: 0, max: 255 },
  ]},
  TA:           { type: 'TA',       label: 'TA',       valueType: 'text' },
  TKEY:         { type: 'TKEY',     label: 'TKEY',     valueType: 'text' },
  TSIG:         { type: 'TSIG',     label: 'TSIG',     valueType: 'text' },
  CAA:          { type: 'CAA',      label: 'CAA',      valueType: 'text', extraFields: [
    { key: 'flags', label: 'Flags', dataType: 'number', required: true, min: 0, max: 255, defaultValue: 0 },
  ]},

  // ── 现代服务绑定 ──────────────────────────
  SVCB:  { type: 'SVCB', label: 'SVCB', valueType: 'text', extraFields: [
    { key: 'priority', label: 'Priority', dataType: 'number', required: true, min: 0, max: 65535, defaultValue: 1 },
  ]},
  HTTPS: { type: 'HTTPS',label: 'HTTPS',valueType: 'text', extraFields: [
    { key: 'priority', label: 'Priority', dataType: 'number', required: true, min: 0, max: 65535, defaultValue: 1 },
  ]},

  // ── ILNP ──────────────────────────────────
  NID: { type: 'NID', label: 'NID', valueType: 'text' },
  L32: { type: 'L32', label: 'L32', valueType: 'text' },
  L64: { type: 'L64', label: 'L64', valueType: 'text' },
  LP:  { type: 'LP',  label: 'LP',  valueType: 'hostname' },

  // ── 硬件地址 ──────────────────────────────
  EUI48: { type: 'EUI48', label: 'EUI48', valueType: 'text' },
  EUI64: { type: 'EUI64', label: 'EUI64', valueType: 'text' },

  // ── 其它标准 RFC ─────────────────────────
  EID:      { type: 'EID',     label: 'EID',     valueType: 'text' },
  NIMLOC:   { type: 'NIMLOC',  label: 'NIMLOC',  valueType: 'text' },
  ATMA:     { type: 'ATMA',    label: 'ATMA',    valueType: 'text' },
  URI:      { type: 'URI',     label: 'URI',     valueType: 'text', extraFields: [
    { key: 'priority', label: 'Priority', dataType: 'number', required: true, min: 0, max: 65535, defaultValue: 10 },
    { key: 'weight',   label: 'Weight',   dataType: 'number', required: true, min: 0, max: 65535, defaultValue: 1 },
  ]},
  AVC:      { type: 'AVC',     label: 'AVC',     valueType: 'text' },
  DOA:      { type: 'DOA',     label: 'DOA',     valueType: 'text' },
  AMTRELAY: { type: 'AMTRELAY',label:'AMTRELAY', valueType: 'text' },
  RESINFO:  { type: 'RESINFO', label:'RESINFO',  valueType: 'text' },
  WALLET:   { type: 'WALLET',  label: 'WALLET',  valueType: 'text' },
  CLA:      { type: 'CLA',     label: 'CLA',     valueType: 'text' },
  IPN:      { type: 'IPN',     label: 'IPN',     valueType: 'text' },
  DSYNC:    { type: 'DSYNC',   label: 'DSYNC',   valueType: 'text' },
  HHIT:     { type: 'HHIT',    label: 'HHIT',    valueType: 'text' },
  BRID:     { type: 'BRID',    label: 'BRID',    valueType: 'text' },
  NXNAME:   { type: 'NXNAME',  label: 'NXNAME',  valueType: 'text' },
};

export function getRecordTypeDef(type: string): RecordTypeDef | undefined {
  return DNS_RECORD_DEFS[type as RecordType];
}

/**
 * IPv6 字面量校验。
 *
 * 不能拿规范化后的 hostname 与原文做字符串相等：`2001:DB8::1` 会被 URL 规范成
 * `2001:db8::1`，导致合法大写/全 8 组写法被判非法（C 端细节轮 P1）。
 */
function isIpv6Literal(value: string): boolean {
  try {
    const url = new URL(`http://[${value}]/`);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return host.includes(':') && /^[0-9a-f:.]+$/i.test(host);
  } catch {
    return false;
  }
}

export function validateRecordValue(type: string, value: string): string | null {
  const def = getRecordTypeDef(type);
  if (!def) return value.trim().length > 0 ? null : 'Value is required';

  const v = value.trim();
  if (!v) return 'Value is required';

  // SRV 的提交值是「priority weight port target」四段（记录名与目标分开），
  // 不能按 hostname 校验整串——否则 UI 新建 SRV 必然失败（第五轮 E2E 卡点）。
  if (type.trim().toUpperCase() === 'SRV') {
    const parts = v.split(/\s+/);
    if (parts.length !== 4) return 'SRV 需要「优先级 权重 端口 目标」四段';
    const [priority, weight, port] = parts;
    if (!/^\d+$/.test(priority) || Number(priority) > 65535) return 'SRV 优先级必须是 0-65535';
    if (!/^\d+$/.test(weight) || Number(weight) > 65535) return 'SRV 权重必须是 0-65535';
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return 'SRV 端口必须是 1-65535';
    return isHostnameCheck(parts[3]) ? null : 'SRV 目标必须是合法主机名';
  }

  switch (def.valueType) {
    case 'ipv4': {
      const parts = v.split('.');
      if (parts.length !== 4) return 'Invalid A record value: must be an IPv4 address';
      const valid = parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
      return valid ? null : 'Invalid A record value: must be a valid IPv4 address';
    }
    case 'ipv6': {
      if (!v.includes(':')) return 'AAAA 记录必须是 IPv6 地址';
      return isIpv6Literal(v) ? null : 'IPv6 地址格式不正确';
    }
    case 'hostname': {
      return isHostnameCheck(v) ? null : 'Invalid hostname value';
    }
    case 'text': {
      if (v.length > 4096) return 'Value too long (max 4096 characters)';
      return null;
    }
    default:
      return null;
  }
}

export function validateExtraField(
  def: RecordTypeDef, fieldKey: string, fieldValue: unknown,
): string | null {
  const fieldDef = def.extraFields?.find(f => f.key === fieldKey);
  if (!fieldDef) return null;
  if (fieldDef.dataType === 'number') {
    const n = Number(fieldValue);
    if (!Number.isFinite(n)) return `${fieldDef.label} must be a number`;
    if (fieldDef.min !== undefined && n < fieldDef.min) return `${fieldDef.label} must be >= ${fieldDef.min}`;
    if (fieldDef.max !== undefined && n > fieldDef.max) return `${fieldDef.label} must be <= ${fieldDef.max}`;
  }
  return null;
}

function isHostnameCheck(value: string): boolean {
  const trimmed = value.trim().replace(/\.$/, '');
  if (!trimmed || trimmed.length > 253) return false;
  if (trimmed === '*') return true;
  const labels = trimmed.split('.');
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label.length === 0 || label.length > 63) return false;
    if (label === '*') { if (i !== 0) return false; continue; }
    if (/[^\x00-\x7F]/.test(label)) {
      try {
        if (label.startsWith('xn--') && !/^xn--[a-z0-9-]+$/i.test(label)) return false;
      } catch { return false; }
    } else {
      if (!/^[a-zA-Z0-9_]([a-zA-Z0-9-_]{0,61}[a-zA-Z0-9_])?$/i.test(label)) return false;
    }
  }
  return true;
}

// ── Practical subsets ───────────────────────────
export const COMMON_RECORD_TYPES: RecordType[] = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'NS', 'PTR'];

export const CLOUDFLARE_RECORD_TYPES: RecordType[] = [
  'A', 'AAAA', 'CAA', 'CERT', 'CNAME', 'DNSKEY', 'DS', 'HTTPS', 'LOC',
  'MX', 'NAPTR', 'NS', 'OPENPGPKEY', 'PTR', 'SMIMEA', 'SRV', 'SSHFP', 'SVCB', 'TLSA', 'TXT', 'URI',
];

export const DOMAIN_VALUE_TYPES: ReadonlySet<RecordType> = new Set(
  (Object.entries(DNS_RECORD_DEFS) as [string, RecordTypeDef][])
    .filter(([, def]) => def.valueType === 'hostname')
    .map(([type]) => type as RecordType),
);

export const PROXIABLE_RECORD_TYPES: ReadonlySet<RecordType> = new Set(['A', 'AAAA', 'CNAME']);
