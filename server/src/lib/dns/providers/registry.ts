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
import { tencenteoOriginGroupCapability } from './tencenteo/extra';
import { mayReuseCredentials } from './credential-sharing';
import { normalizeProviderType } from '../providerAlias';
import { virtualOriginGroupCapability } from './virtual/extra';
import { isVirtualProviderEnabled } from './availability';
import { findSharingInconsistencies, listSharingParticipants } from './credential-sharing';

export interface DnsCapabilities {
  remark: boolean;
  status: boolean;
  weight: boolean;
  proxiable: boolean;
  cnameFlattening: boolean;
  recordTypes: RecordType[];
}

export interface ProviderCapabilities {
  dns: DnsCapabilities | null;
  log: boolean;
  renewal: boolean;
  /** 是否支持记录级重定向（未声明/为 false 时，API 传入的 redirect 一律忽略） */
  redirect: boolean;
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
  /** 线路来源：builtin=内置静态表；dynamic=动态请求上游。二选一，不允许「动态 + 内置兜底」 */
  lineSource: 'builtin' | 'dynamic';
  /** 默认线路 ID：未指定 line（或历史哨兵 '0'）时使用，适配器必须显式实现 */
  defaultLine: string;
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

/**
 * 全部提供商定义（含仅开发可用的那些）。
 * 对外暴露的是下面的 `providerDefinitions`，已按可用性过滤。
 */
const allProviderDefinitions: ProviderDefinition[] = [
  {
    type: 'aliyun',
    name: 'provider.aliyun',
    lineSource: 'dynamic',
    defaultLine: '0',
    capabilities: { dns: { remark: false, status: true, weight: false, proxiable: false, cnameFlattening: true, recordTypes: COMMON_RECORD_TYPES }, log: true, renewal: false, redirect: false },
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
    lineSource: 'dynamic',
    defaultLine: '0',
    capabilities: { dns: { remark: false, status: true, weight: false, proxiable: false, cnameFlattening: true, recordTypes: COMMON_RECORD_TYPES }, log: true, renewal: false, redirect: false },
    configFields: [
      { key: 'SecretId', label: 'provider.config.secret_id', type: 'text', required: true },
      { key: 'SecretKey', label: 'provider.config.secret_key', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.DnspodAdapter(config),
  },
  {
    type: 'huawei',
    name: 'provider.huawei',
    lineSource: 'dynamic',
    defaultLine: 'default_view',
    capabilities: { dns: { remark: false, status: true, weight: false, proxiable: false, cnameFlattening: true, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false, redirect: false },
    configFields: [
      { key: 'AccessKeyId', label: 'provider.config.access_key_id', type: 'text', required: true },
      { key: 'SecretAccessKey', label: 'provider.config.secret_access_key', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.HuaweiAdapter(config),
  },
  {
    type: 'baidu',
    name: 'provider.baidu',
    lineSource: 'builtin',
    defaultLine: '0',
    capabilities: { dns: { remark: false, status: true, weight: false, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false, redirect: false },
    configFields: [
      { key: 'AccessKeyId', label: 'provider.config.access_key_id', type: 'text', required: true },
      { key: 'SecretAccessKey', label: 'provider.config.secret_access_key', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.BaiduAdapter(config),
  },
  {
    type: 'huoshan',
    name: 'provider.huoshan',
    lineSource: 'dynamic',
    defaultLine: '0',
    capabilities: { dns: { remark: false, status: true, weight: false, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false, redirect: false },
    configFields: [
      { key: 'AccessKeyId', label: 'provider.config.access_key_id', type: 'text', required: true },
      { key: 'SecretAccessKey', label: 'provider.config.secret_access_key', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.HuoshanAdapter(config),
  },
  {
    type: 'jdcloud',
    name: 'provider.jdcloud',
    lineSource: 'dynamic',
    defaultLine: '0',
    capabilities: { dns: { remark: false, status: true, weight: false, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false, redirect: false },
    configFields: [
      { key: 'AccessKeyId', label: 'provider.config.access_key_id', type: 'text', required: true },
      { key: 'AccessKeySecret', label: 'provider.config.access_key_secret', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.JdcloudAdapter(config),
  },
  {
    type: 'cloudflare',
    name: 'provider.cloudflare',
    lineSource: 'builtin',
    defaultLine: '0',
    capabilities: { dns: { remark: true, status: false, weight: true, proxiable: true, cnameFlattening: true, recordTypes: CLOUDFLARE_RECORD_TYPES }, log: false, renewal: false, redirect: false },
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
    lineSource: 'dynamic',
    defaultLine: '0',
    capabilities: { dns: { remark: false, status: true, weight: true, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false, redirect: false },
    configFields: [
      { key: 'apiid', label: 'provider.config.api_id', type: 'text', required: true },
      { key: 'apisecret', label: 'provider.config.api_secret', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.DnslaAdapter(config),
  },
  {
    type: 'west',
    name: 'provider.west',
    lineSource: 'builtin',
    defaultLine: '0',
    capabilities: { dns: { remark: false, status: true, weight: false, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false, redirect: false },
    configFields: [
      { key: 'username', label: 'provider.config.username', type: 'text', required: true },
      { key: 'api_password', label: 'provider.config.api_password', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.WestAdapter(config),
  },
  {
    type: 'qingcloud',
    name: 'provider.qingcloud',
    lineSource: 'dynamic',
    defaultLine: '0',
    capabilities: { dns: { remark: false, status: true, weight: false, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false, redirect: false },
    configFields: [
      { key: 'access_key_id', label: 'provider.config.access_key_id_label', type: 'text', required: true },
      { key: 'secret_access_key', label: 'provider.config.secret_access_key_label', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.QingcloudAdapter(config),
  },
  {
    type: 'namesilo',
    name: 'provider.namesilo',
    lineSource: 'builtin',
    defaultLine: '0',
    capabilities: { dns: { remark: false, status: false, weight: false, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false, redirect: false },
    configFields: [{ key: 'apikey', label: 'provider.config.api_key', type: 'password', required: true }],
    adapterFactory: (config) => new Adapters.NamesiloAdapter(config),
  },
  {
    type: 'bt',
    name: 'provider.bt',
    lineSource: 'dynamic',
    defaultLine: '0',
    capabilities: { dns: { remark: false, status: true, weight: false, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false, redirect: false },
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
    lineSource: 'builtin',
    defaultLine: '0',
    capabilities: { dns: { remark: false, status: false, weight: false, proxiable: false, cnameFlattening: true, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false, redirect: false },
    configFields: [
      { key: 'apiKey', label: 'provider.config.api_key', type: 'text', required: true },
      { key: 'apiSecret', label: 'provider.config.api_secret', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.SpaceshipAdapter(config),
  },
  {
    type: 'powerdns',
    name: 'provider.powerdns',
    lineSource: 'builtin',
    defaultLine: '0',
    capabilities: { dns: { remark: false, status: true, weight: false, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false, redirect: false },
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
    lineSource: 'builtin',
    defaultLine: '0',
    capabilities: { dns: { remark: false, status: true, weight: false, proxiable: true, cnameFlattening: true, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false, redirect: false },
    configFields: [
      { key: 'AccessKeyId', label: 'provider.config.access_key_id', type: 'text', required: true },
      { key: 'AccessKeySecret', label: 'provider.config.access_key_secret', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.AliyunesaAdapter(config),
  },
  {
    type: 'tencenteo',
    name: 'provider.tencenteo',
    lineSource: 'builtin',
    defaultLine: 'Default',
    capabilities: { dns: { remark: false, status: true, weight: false, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false, redirect: false },
    extraCapabilities: [tencenteoOriginGroupCapability],
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
    /**
     * 虚拟提供商：不需要任何真实凭证，用于完整演练工作流。
     * 默认关闭，必须在账号配置里显式 `virtual_enabled=true` 才可用（失败关闭）。
     * 另有进程级硬开关 HIDNS_DISABLE_VIRTUAL_PROVIDER=1，生产可一键停用。
     */
    type: 'virtual',
    name: 'provider.virtual',
    lineSource: 'builtin',
    defaultLine: 'default',
    capabilities: { dns: { remark: true, status: true, weight: false, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false, redirect: false },
    extraCapabilities: [virtualOriginGroupCapability],
    configFields: [
      { key: 'virtual_enabled', label: 'provider.config.virtual_enabled', type: 'select', required: true, options: [
        { value: 'true', label: 'provider.config.virtual_enabled_on' },
        { value: 'false', label: 'provider.config.virtual_enabled_off' },
      ]},
      { key: 'virtual_tenant', label: 'provider.config.virtual_tenant', type: 'text', required: false },
      { key: 'virtual_state', label: 'provider.config.virtual_state', type: 'select', required: false, options: [
        { value: 'file', label: 'provider.config.virtual_state_file' },
        { value: 'memory', label: 'provider.config.virtual_state_memory' },
      ]},
      { key: 'virtual_seed', label: 'provider.config.virtual_seed', type: 'select', required: false, options: [
        { value: 'demo', label: 'provider.config.virtual_seed_demo' },
        { value: 'empty', label: 'provider.config.virtual_seed_empty' },
      ]},
    ],
    adapterFactory: (config) => new Adapters.VirtualAdapter(config),
  },
  {
    type: 'dnshe',
    name: 'provider.dnshe',
    lineSource: 'builtin',
    defaultLine: '0',
    capabilities: { dns: { remark: false, status: false, weight: false, proxiable: false, cnameFlattening: true, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: true, redirect: false },
    configFields: [
      { key: 'apiKey', label: 'provider.config.api_key', type: 'text', required: true },
      { key: 'apiSecret', label: 'provider.config.api_secret', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.DnsheAdapter(config),
  },
  {
    type: 'rainyun',
    name: 'provider.rainyun',
    lineSource: 'builtin',
    defaultLine: 'DEFAULT',
    capabilities: { dns: { remark: false, status: false, weight: false, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false, redirect: false },
    configFields: [{ key: 'apiKey', label: 'provider.config.api_key', type: 'password', required: true }],
    adapterFactory: (config) => new Adapters.RainyunAdapter(config),
  },
  {
    type: 'hidns',
    name: 'provider.hidns',
    lineSource: 'builtin',
    defaultLine: '0',
    capabilities: { dns: { remark: true, status: true, weight: true, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false, redirect: false },
    configFields: [
      { key: 'baseUrl', label: 'provider.config.hidns_url', type: 'text', required: true },
      { key: 'apiToken', label: 'provider.config.api_token', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.HiDNSAdapter(config),
  },
  {
    type: 'hidns_v2',
    name: 'provider.hidns_v2',
    lineSource: 'dynamic',
    defaultLine: '0',
    capabilities: { dns: { remark: true, status: true, weight: true, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false, redirect: false },
    configFields: [
      { key: 'baseUrl', label: 'provider.config.hidns_url', type: 'text', required: true },
      { key: 'apiToken', label: 'provider.config.api_token', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.HidnsV2Adapter(config),
  },
  {
    type: 'caihongdns',
    name: 'provider.caihongdns',
    lineSource: 'builtin',
    defaultLine: '默认',
    capabilities: { dns: { remark: true, status: true, weight: true, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false, redirect: false },
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
    lineSource: 'builtin',
    defaultLine: '0',
    capabilities: { dns: { remark: false, status: false, weight: false, proxiable: false, cnameFlattening: false, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false, redirect: false },
    configFields: [
      { key: 'apiKey', label: 'provider.config.api_key', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.Vps8Adapter(config),
  },
  {
    type: 'gcore',
    name: 'provider.gcore',
    lineSource: 'builtin',
    defaultLine: '0',
    capabilities: { dns: { remark: false, status: true, weight: false, proxiable: false, cnameFlattening: true, recordTypes: COMMON_RECORD_TYPES }, log: false, renewal: false, redirect: false },
    configFields: [
      { key: 'apiKey', label: 'provider.config.api_key', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.GcoreAdapter(config as any),
  },
  {
    type: 'dnsneko',
    name: 'provider.dnsneko',
    lineSource: 'dynamic',
    defaultLine: 'default',
    capabilities: { dns: { remark: true, status: true, weight: false, proxiable: false, cnameFlattening: true, recordTypes: DNSNEKO_RECORD_TYPES }, log: false, renewal: false, redirect: false },
    configFields: [
      { key: 'username', label: 'provider.config.username', type: 'text', required: true },
      { key: 'apiKey', label: 'provider.config.api_key', type: 'password', required: true },
    ],
    adapterFactory: (config) => new Adapters.DnsnekoAdapter(config),
  },
  {
    type: 'dpdns_reverse',
    name: 'provider.dpdns_reverse',
    lineSource: 'builtin',
    defaultLine: '0',
    capabilities: { dns: null, log: false, renewal: true, redirect: false },
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

/**
 * 跨提供商凭据复用必须两端相互声明。
 * 声明不一致（只有一边、或引用了不存在的提供商）时**启动即失败**，
 * 不允许带着半截授权跑起来 —— 那等于给恶意提供商留了注入面。
 */
function validateCredentialSharing(definitions: ProviderDefinition[]): void {
  const types = new Set(definitions.map((definition) => definition.type));
  const problems = findSharingInconsistencies();
  const { importers, sources } = listSharingParticipants();
  for (const type of new Set([...importers, ...sources])) {
    if (!types.has(type)) problems.push(`凭据复用声明引用了不存在的提供商: ${type}`);
  }
  if (problems.length > 0) {
    throw new Error('跨提供商凭据复用声明不一致:\n  ' + problems.join('\n  '));
  }
}

validateDefinitions(allProviderDefinitions);
validateCredentialSharing(allProviderDefinitions);

/**
 * 对外注册的提供商。
 *
 * 虚拟提供商是**开发工具**：未显式开启（或处于生产环境）时，这里根本不注册它。
 * 摘除后连带生效的有三件事：
 *   1. `/api/accounts/providers` 不返回它 —— 界面上看不见
 *   2. `createAdapter('virtual')` 抛 Unknown provider type —— 建不了账号
 *   3. `ext.virtual.*` 不在动作注册表里 —— 工作流引用不了（ext 的二级前缀取自本列表）
 */
export const providerDefinitions: ProviderDefinition[] = allProviderDefinitions.filter(
  (definition) => definition.type !== 'virtual' || isVirtualProviderEnabled(),
);

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

/**
 * 该提供商的账号是否**原生**支持源站组（按 `extraCapabilities` 派生，不新增 `DnsCapabilities` 字段）。
 *
 * 派生而非写死字段的理由：给 `DnsCapabilities` 加必填项要改 25 处字面量 + 客户端手抄结构，
 * 且客户端漏改不报错；而 `extraCapabilities` 已经在 `/api/accounts/providers` 整个下发。
 */
export function getOriginGroupCapability(providerType: string): boolean {
  // 历史账号行可能存的是别名（如 'edgeone'），不归一会把这类账号判成「不支持」
  // 而从 `accounts?originGroup=true` 里消失
  const normalized = normalizeProviderType(providerType);
  return (providerDefinitionMap.get(normalized)?.extraCapabilities ?? []).some((capability) =>
    capability.name.endsWith('.originGroup'),
  );
}

/**
 * 该账号是否**可操作源站组**：原生支持 ∪ 被允许复用凭据。
 *
 * 必须包含复用这一支：DNSPod 账号（providerType = 'dnspod'）能操作源站组，
 * 是因为它声明了复用腾讯云凭据——漏掉这支会让唯一能用源站组的用户群在 UI 里失去入口。
 *
 * 放在注册表而不是提供商目录：这是**通用能力谓词**，候选源、执行路径、路由都要用；
 * 留在 tencenteo 目录会让路由反向 import 某个提供商的私有模块（分层倒置）。
 */
export function isOriginGroupCapableAccount(providerType: string): boolean {
  return (
    getOriginGroupCapability(providerType) ||
    mayReuseCredentials('tencenteo', normalizeProviderType(providerType))
  );
}
