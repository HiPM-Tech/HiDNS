import { DnsAdapter } from './DnsInterface';
import { TencenteoAdapter } from './providers/tencenteo/adapter';
import {
  ProviderCapabilities,
  ProviderConfigField,
  ProviderInfo,
  getProviderDefinitions,
  getProviderInfoList,
  providerDefinitionMap,
} from './providers/registry';
import { createLogger } from '../logger';
import { normalizeProviderType } from './providerAlias';

const log = createLogger('DNS').sub('Helper');

export type { ProviderCapabilities, ProviderConfigField, ProviderInfo };

// All providers now have implementations
const STUB_TYPES = new Set<string>([]);

/**
 * 惰性求值。
 *
 * 这里原本在模块顶层就调用 getProviderInfoList()，而 registry → providers/index →
 * 提供商 extra → dns-provider-service → 本文件 → registry 构成环。
 * 顶层调用会在"从 registry 侧进入"时撞上 providerDefinitions 的 TDZ。
 * 改成调用时求值后，加载顺序不再影响结果；提供商列表很短，这点开销可以忽略。
 */
export function getProviders(includeStub = false): ProviderInfo[] {
  const enriched = getProviderInfoList().map((p) => ({ ...p, isStub: STUB_TYPES.has(p.type) }));
  if (includeStub) return enriched;
  return enriched.filter((p) => !p.isStub);
}

export function getProvider(type: string): ProviderInfo | undefined {
  return getProviderDefinitions().find((provider) => provider.type === type);
}

export function isStubProvider(type: string): boolean {
  return STUB_TYPES.has(type);
}

function sanitizeArgs(args: unknown[]): unknown[] {
  return args.map((arg) => {
    if (typeof arg === 'string' && arg.length > 500) return arg.substring(0, 500) + '...';
    return arg;
  });
}

const ADAPTER_METHODS = new Set([
  'check', 'getDomainList', 'getDomainRecords', 'getDomainRecordInfo',
  'addDomainRecord', 'updateDomainRecord', 'deleteDomainRecord',
  'setDomainRecordStatus', 'getRecordLines', 'getMinTTL', 'addDomain',
]);

function createLoggingAdapter(adapter: DnsAdapter, providerType: string): DnsAdapter {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (typeof original !== 'function' || !ADAPTER_METHODS.has(String(prop))) {
        return original;
      }

      const methodName = String(prop);
      return async (...args: unknown[]) => {
        const start = Date.now();
        log.sub('AdapterProxy').sub(providerType).sub(methodName).tag('CALL').debug('Adapter method called', { args: sanitizeArgs(args) });
        try {
          const result = await original.apply(target, args);
          log.sub('AdapterProxy').sub(providerType).sub(methodName).tag('SUCCESS').debug('Adapter method completed', { durationMs: Date.now() - start });
          return result;
        } catch (e) {
          log.sub('AdapterProxy').sub(providerType).sub(methodName).tag('FAILED').error('Adapter method failed', { durationMs: Date.now() - start, error: e });
          throw e;
        }
      };
    },
  });
}

export function createAdapter(type: string, config: Record<string, string>, domain?: string, zoneId?: string, domainId?: string): DnsAdapter {
  // 工厂入口归一化：历史库/外部集成可能存的是 lego 别名（alidns/aliesa/…），
  // 不归一化会让 createAdapter('aliesa') 抛 Unknown provider type。
  const definition = providerDefinitionMap.get(normalizeProviderType(type));
  if (!definition) {
    throw new Error(`Unknown provider type: ${type}`);
  }

  // 将 domain、zoneId 和 domainId 添加到 config 中，供需要它们的提供商使用
  const enhancedConfig = { ...config };
  if (domain) enhancedConfig.domain = domain;
  if (zoneId) enhancedConfig.zoneId = zoneId;
  if (domainId) enhancedConfig.domainId = domainId;

  const adapter = definition.adapterFactory(enhancedConfig);

  // 对于腾讯 EO 适配器，设置 Zone ID 和域名
  if (type === 'tencenteo' && adapter instanceof TencenteoAdapter) {
    log.sub('AdapterFactory').sub('TencentEO').debug('Creating adapter', { domain, zoneId, hasZoneId: !!zoneId, hasDomain: !!domain });
    if (zoneId && domain) {
      adapter.setZoneInfo(zoneId, domain);
      log.sub('AdapterFactory').sub('TencentEO').tag('SUCCESS').debug('ZoneInfo set', { zoneId, domain });
    } else {
      log.sub('AdapterFactory').sub('TencentEO').tag('VALIDATION').warn('Missing zoneId or domain', { zoneId, domain });
    }
  }

  return createLoggingAdapter(adapter, type);
}
