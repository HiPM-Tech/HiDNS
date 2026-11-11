/**
 * DNS Providers Internal Module
 *
 * This module re-exports external dependencies for internal use within DNS providers.
 * It provides a centralized place to manage external dependencies and simplifies imports.
 *
 * Usage in provider files:
 * ```typescript
 * import { createProviderAdapterLogger, fetchWithFallback, BaseAdapter } from './internal';
 * ```
 */

// ============================================================================
// Logger
// ============================================================================
import { createLogger } from '../../logger';

const log = createLogger('DNS');

export const createDnsLogger = () => log;
export const createDnsHelperLogger = () => log.sub('Helper');
export const createDnsResolverLogger = (resolver: string) => log.sub('Resolver').sub(resolver);
export const createProviderLogger = (provider: string) => log.sub('Provider').sub(provider);
export const createProviderAdapterLogger = (provider: string) => createProviderLogger(provider).sub('Adapter');
export const createProviderAuthLogger = (provider: string) => createProviderLogger(provider).sub('Auth');

/**
 * 账号 config 里的布尔开关（如 useProxy）统一按字符串存储（'true' / 'false'），
 * 直接用 `!!value` 会把 'false' 判成真，这里做一次归一。
 */
export function isTruthyFlag(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}
export const createProviderApiLogger = (provider: string) => createProviderLogger(provider).sub('API');
export const createProviderRenewalLogger = (provider: string) => createProviderLogger(provider).sub('Renewal');
export const createProviderWhoisLogger = (provider: string) => createProviderLogger(provider).sub('Whois');

// ============================================================================
// HTTP Utilities
// ============================================================================
export { fetchWithFallback } from '../../proxy-http';
export { requestXml } from './http';
export { normalizeLine } from '../line-normalizer';

// ============================================================================
// Common Types and Utilities
// ============================================================================
export {
  asArray,
  Dict,
  normalizeRrName,
  safeString,
  BaseAdapter,
  AliyunRpcAdapter,
  TencentCloudAdapter,
  toNumber,
  toRecordStatus,
  resolveDomainIdHelper,
  resolveCreatedRecordId,
  resolveProviderLine,
  requireNumericRecordId,
  parseCompositeRecordId,
  uuid,
  isSrv,
  parseSrvValue,
  buildSrvValue,
} from './common';

// ============================================================================
// DNS Interface Types
// ============================================================================
export type {
  DnsAdapter,
  DnsRecord,
  DomainInfo,
  PageResult,
} from '../DnsInterface';

// ============================================================================
// Helper Functions
// 注意：此处**不得**再导出 ../DnsHelper。
// 依赖链 DnsHelper → providers/index → <adapter> → internal 与
// internal → DnsHelper 构成循环，ESM 下 export-from 会被提升，
// 导致 adapter 执行时 createProviderAdapterLogger 尚未初始化（TDZ）。
// 需要 createAdapter 的调用方请直接 import '../lib/dns/DnsHelper'。
// ============================================================================
