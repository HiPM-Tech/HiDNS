import { DnsAdapter } from '../DnsInterface';
import type { RecordType } from '../record-types';
import { COMMON_RECORD_TYPES, CLOUDFLARE_RECORD_TYPES } from '../record-types';

const DNSNEKO_RECORD_TYPES: RecordType[] = [
  ...COMMON_RECORD_TYPES,
  'DNAME', 'AFSDB', 'NAPTR', 'CERT',
  'OPENPGPKEY', 'DS', 'TLSA', 'SSHFP', 'RP', 'HINFO', 'LOC',
];
import * as Adapters from './index';
import type { ProviderExtraCapability } from './extra-types';

export interface DnsCapabilities {
  remark: boolean;
  status: boolean;
  redirect: boolean;
  weight: boolean;
  proxiable: boolean;
  cnameFlattening: boolean;
  recordTypes: RecordType[];
}

export interface ProviderCapabilities {
  dns: DnsCapabilities | null;
  log: boolean;
  renewal: boolean;
}

export interface ProviderConfigFieldOption {
  value: string;
  label: string;
}

export interface ProviderConfigField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'select';
  required: boolean;
  group?: string;
  options?: ProviderConfigFieldOption[];
}

export interface ProviderDefinition {
  type: string;
  name: string;
  capabilities: ProviderCapabilities;
  configFields: ProviderConfigField[];
  adapterFactory: (config: Record<string, string>) => DnsAdapter;
  /**
   * 提供商独有能力（可选）。核心只校验命名与唯一性，不解释语义。
   * 设计依据：docs/WORKFLOW_ENGINE_DESIGN.md §3.7.4 / §3.7.6
   */
  extraCapabilities?: ProviderExtraCapability[];
}

export type ProviderInfo = Omit<ProviderDefinition, 'adapterFactory'>;

// ─── 预设记录类型（可直接用于 recordTypes） — 定义见 record-types.ts ────

export const providerDefinitions: ProviderDefinition[] = [
  {
    type: 'aliyun',
    name: 'provider.aliyun',
    capabilities: { dns: { remark: false, status: true, redirect: false, weight: false, proxiable: false, cnameFlattening: true, recordTypes: COMMON_RECORD_TYPES }, log: true, renewal: false },
    configFields: [
      { key: 'AccessKeyId', label: 'provider.config.access_key_id', type: 'text', required: true },
      { key: 'AccessKeySecret', label: 'provider.config.access_key_secret', type: 'password', required: true },
      { key: 'region', label: 'provider.config.region', type: 'text', required: false },
    ],
    adapterFactory: (config) => new Adapters.AliyunAdapter(config),
  },
  {
    type: 'dnspod',
    name: 'provider.dnspod',
    capabilities: { dns: { remark: false, status: true, redirect: false, weight: false, proxiable: false, cnameFlattening: true, recordTypes: COMMON_RECORD_TYPES }, log: true, renewal: false },
    configFields: [
      { key: 'SecretId', label: 'provider.config.secret_id', type: 'text', required: true },
      { key: 'SecretKey', label: 'provider.config.secret_key', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.DnspodAdapter(config),
  },
  {
    type: 'huawei',
    name: 'provider.huawei',
    capabilities: { dns: { remark: false, status: true, redirect: false, weight: false, proxiable: false, cnameFlattening: true, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false },
    configFields: [
      { key: 'AccessKeyId', label: 'provider.config.access_key_id', type: 'text', required: true },
      { key: 'SecretAccessKey', label: 'provider.config.secret_access_key', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.HuaweiAdapter(config),
  },
  {
    type: 'baidu',
    name: 'provider.baidu',
    capabilities: { dns: { remark: false, status: true, redirect: false, weight: false, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false },
    configFields: [
      { key: 'AccessKeyId', label: 'provider.config.access_key_id', type: 'text', required: true },
      { key: 'SecretAccessKey', label: 'provider.config.secret_access_key', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.BaiduAdapter(config),
  },
  {
    type: 'huoshan',
    name: 'provider.huoshan',
    capabilities: { dns: { remark: false, status: true, redirect: false, weight: false, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false },
    configFields: [
      { key: 'AccessKeyId', label: 'provider.config.access_key_id', type: 'text', required: true },
      { key: 'SecretAccessKey', label: 'provider.config.secret_access_key', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.HuoshanAdapter(config),
  },
  {
    type: 'jdcloud',
    name: 'provider.jdcloud',
    capabilities: { dns: { remark: false, status: true, redirect: false, weight: false, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false },
    configFields: [
      { key: 'AccessKeyId', label: 'provider.config.access_key_id', type: 'text', required: true },
      { key: 'AccessKeySecret', label: 'provider.config.access_key_secret', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.JdcloudAdapter(config),
  },
  {
    type: 'cloudflare',
    name: 'provider.cloudflare',
    capabilities: { dns: { remark: true, status: false, redirect: true, weight: true, proxiable: true, cnameFlattening: true, recordTypes: CLOUDFLARE_RECORD_TYPES }, log: false, renewal: false },
    configFields: [
      { key: 'accountId', label: 'provider.config.account_id_tunnels', type: 'text', required: false, group: 'token' },
      { key: 'apiToken', label: 'provider.config.api_token', type: 'password', required: true, group: 'token' },
      { key: 'email', label: 'provider.config.email', type: 'text', required: false, group: 'key' },
      { key: 'apiKey', label: 'provider.config.global_api_key', type: 'password', required: false, group: 'key' },
    ],
    adapterFactory: (config) => new Adapters.CloudflareAdapter(config),
  },
  {
    type: 'dnsla',
    name: 'provider.dnsla',
    capabilities: { dns: { remark: false, status: true, redirect: false, weight: true, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false },
    configFields: [
      { key: 'apiid', label: 'provider.config.api_id', type: 'text', required: true },
      { key: 'apisecret', label: 'provider.config.api_secret', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.DnslaAdapter(config),
  },
  {
    type: 'west',
    name: 'provider.west',
    capabilities: { dns: { remark: false, status: true, redirect: false, weight: false, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false },
    configFields: [
      { key: 'username', label: 'provider.config.username', type: 'text', required: true },
      { key: 'api_password', label: 'provider.config.api_password', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.WestAdapter(config),
  },
  {
    type: 'qingcloud',
    name: 'provider.qingcloud',
    capabilities: { dns: { remark: false, status: true, redirect: false, weight: false, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false },
    configFields: [
      { key: 'access_key_id', label: 'provider.config.access_key_id_label', type: 'text', required: true },
      { key: 'secret_access_key', label: 'provider.config.secret_access_key_label', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.QingcloudAdapter(config),
  },
  {
    type: 'namesilo',
    name: 'provider.namesilo',
    capabilities: { dns: { remark: false, status: false, redirect: false, weight: false, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false },
    configFields: [{ key: 'apikey', label: 'provider.config.api_key', type: 'password', required: true }],
    adapterFactory: (config) => new Adapters.NamesiloAdapter(config),
  },
  {
    type: 'bt',
    name: 'provider.bt',
    capabilities: { dns: { remark: false, status: true, redirect: false, weight: false, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false },
    configFields: [
      { key: 'AccountID', label: 'provider.config.account_id', type: 'text', required: true },
      { key: 'AccessKey', label: 'provider.config.access_key', type: 'password', required: true },
      { key: 'SecretKey', label: 'provider.config.secret_key_generic', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.BtAdapter(config),
  },
  {
    type: 'spaceship',
    name: 'provider.spaceship',
    capabilities: { dns: { remark: false, status: false, redirect: false, weight: false, proxiable: false, cnameFlattening: true, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false },
    configFields: [
      { key: 'apiKey', label: 'provider.config.api_key', type: 'text', required: true },
      { key: 'apiSecret', label: 'provider.config.api_secret', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.SpaceshipAdapter(config),
  },
  {
    type: 'powerdns',
    name: 'provider.powerdns',
    capabilities: { dns: { remark: false, status: true, redirect: false, weight: false, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false },
    configFields: [
      { key: 'serverUrl', label: 'provider.config.server_url', type: 'text', required: true },
      { key: 'apiKey', label: 'provider.config.api_key', type: 'password', required: true },
      { key: 'serverId', label: 'provider.config.server_id', type: 'text', required: false },
    ],
    adapterFactory: (config) => new Adapters.PowerdnsAdapter(config),
  },
  {
    type: 'aliyunesa',
    name: 'provider.aliyunesa',
    capabilities: { dns: { remark: false, status: true, redirect: false, weight: false, proxiable: true, cnameFlattening: true, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false },
    configFields: [
      { key: 'AccessKeyId', label: 'provider.config.access_key_id', type: 'text', required: true },
      { key: 'AccessKeySecret', label: 'provider.config.access_key_secret', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.AliyunesaAdapter(config),
  },
  {
    type: 'tencenteo',
    name: 'provider.tencenteo',
    capabilities: { dns: { remark: false, status: true, redirect: false, weight: false, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false },
    configFields: [
      { key: 'SecretId', label: 'provider.config.secret_id', type: 'text', required: true },
      { key: 'SecretKey', label: 'provider.config.secret_key', type: 'password', required: true },
      { key: 'site_type', label: 'provider.config.site_type', type: 'select', required: true, options: [
        { value: 'mainland', label: 'provider.config.site_type_mainland' },
        { value: 'intl', label: 'provider.config.site_type_intl' },
      ]},
    ],
    adapterFactory: (config) => new Adapters.TencenteoAdapter(config),
  },
  {
    type: 'dnshe',
    name: 'provider.dnshe',
    capabilities: { dns: { remark: false, status: false, redirect: false, weight: false, proxiable: false, cnameFlattening: true, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: true },
    configFields: [
      { key: 'apiKey', label: 'provider.config.api_key', type: 'text', required: true },
      { key: 'apiSecret', label: 'provider.config.api_secret', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.DnsheAdapter(config),
  },
  {
    type: 'rainyun',
    name: 'provider.rainyun',
    capabilities: { dns: { remark: false, status: false, redirect: false, weight: false, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false },
    configFields: [{ key: 'apiKey', label: 'provider.config.api_key', type: 'password', required: true }],
    adapterFactory: (config) => new Adapters.RainyunAdapter(config),
  },
  {
    type: 'hidns',
    name: 'provider.hidns',
    capabilities: { dns: { remark: true, status: true, redirect: false, weight: true, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false },
    configFields: [
      { key: 'baseUrl', label: 'provider.config.hidns_url', type: 'text', required: true },
      { key: 'apiToken', label: 'provider.config.api_token', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.HiDNSAdapter(config),
  },
  {
    type: 'hidns_v2',
    name: 'provider.hidns_v2',
    capabilities: { dns: { remark: true, status: true, redirect: false, weight: true, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false },
    configFields: [
      { key: 'baseUrl', label: 'provider.config.hidns_url', type: 'text', required: true },
      { key: 'apiToken', label: 'provider.config.api_token', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.HidnsV2Adapter(config),
  },
  {
    type: 'caihongdns',
    name: 'provider.caihongdns',
    capabilities: { dns: { remark: true, status: true, redirect: false, weight: true, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false },
    configFields: [
      { key: 'baseUrl', label: 'provider.config.caihong_url', type: 'text', required: true },
      { key: 'uid', label: 'provider.config.user_id', type: 'text', required: true },
      { key: 'apiKey', label: 'provider.config.api_key', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.CaihongDnsAdapter(config),
  },
  {
    type: 'vps8',
    name: 'provider.vps8',
    capabilities: { dns: { remark: false, status: false, redirect: false, weight: false, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false },
    configFields: [
      { key: 'apiKey', label: 'provider.config.api_key', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.Vps8Adapter(config),
  },
  {
    type: 'gcore',
    name: 'provider.gcore',
    capabilities: { dns: { remark: false, status: true, redirect: false, weight: false, proxiable: false, cnameFlattening: true, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false },
    configFields: [
      { key: 'apiKey', label: 'provider.config.api_key', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.GcoreAdapter(config as any),
  },
  {
    type: 'dnsneko',
    name: 'provider.dnsneko',
    capabilities: { dns: { remark: true, status: true, redirect: false, weight: false, proxiable: false, cnameFlattening: true, recordTypes: DNSNEKO_RECORD_TYPES }, log: false, renewal: false },
    configFields: [
      { key: 'username', label: 'provider.config.username', type: 'text', required: true },
      { key: 'apiKey', label: 'provider.config.api_key', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.DnsnekoAdapter(config),
  },
  {
    type: 'dpdns_reverse',
    name: 'provider.dpdns_reverse',
    capabilities: { dns: null, log: false, renewal: true },
    configFields: [
      { key: 'rememberToken', label: 'provider.config.remember_token', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.DpdnsReverseAdapter(config),
  },
];

function validateDefinitions(definitions: ProviderDefinition[]): void {
  const seenTypes = new Set<string>();

  for (const definition of definitions) {
    if (seenTypes.has(definition.type)) {
      throw new Error(`Duplicate provider type detected in registry: "${definition.type}"`);
    }
    seenTypes.add(definition.type);

    const seenConfigKeys = new Set<string>();
    for (const field of definition.configFields) {
      if (seenConfigKeys.has(field.key)) {
        throw new Error(
          `Duplicate config key detected in provider "${definition.type}": "${field.key}"`,
        );
      }
      seenConfigKeys.add(field.key);
    }
  }
}

validateDefinitions(providerDefinitions);

export const providerDefinitionMap = new Map(providerDefinitions.map((definition) => [definition.type, definition]));

/**
 * 全部提供商类型。供命名空间二次下派（ext 模块的二级前缀）使用。
 * 设计依据：docs/WORKFLOW_ENGINE_DESIGN.md §3.7.4
 */
export const PROVIDER_TYPES: readonly string[] = providerDefinitions.map((definition) => definition.type);

export function getProviderDefinitions(): ProviderDefinition[] {
  return providerDefinitions;
}

export function getProviderInfoList(): ProviderInfo[] {
  return providerDefinitions.map(({ adapterFactory, ...providerInfo }) => providerInfo);
}
