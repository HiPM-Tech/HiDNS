/**
 * DNS 提供商 WHOIS 源注册表
 *
 * 与 methods/whois.adapter / rdap.adapter / http-api.adapter 同级。
 * 所有类型的 WHOIS 查询方式都在 methods/ 下。
 *
 * DNS 提供商 WHOIS 需要账号授权配置（API Key 等），
 * 因此使用独立注册表 + DnsWhoisSource 接口。
 *
 * 同时保持旧的 WhoisScheduler 接口和 dnsProviderAdapter
 * 作为桥接层，兼容 lib/dns/providers/dnshe/whoisScheduler.ts
 */

import { DnsWhoisSource, WhoisScheduler, WhoisSchedulerResult, WhoisResult } from '../types';
import { extractExpiryDate } from '../data-parser';
import { createLogger } from '../../../lib/logger';

const log = createLogger('WhoisService').sub('DnsProviderRegistry');

// ========== 旧接口保留（桥接 WhoisScheduler → DnsWhoisSource） ==========

class DnsProviderAdapterRegistry {
  private adapters = new Map<string, WhoisScheduler>();

  register(adapter: WhoisScheduler): void {
    if (this.adapters.has(adapter.type)) {
      log.warn(`Adapter for type "${adapter.type}" already registered, overwriting`);
    }
    this.adapters.set(adapter.type, adapter);
    log.info(`Registered adapter for type: ${adapter.type}`);
  }

  getAdapter(type: string): WhoisScheduler | null {
    return this.adapters.get(type) || null;
  }

  hasAdapter(type: string): boolean {
    return this.adapters.has(type);
  }

  getRegisteredTypes(): string[] {
    return Array.from(this.adapters.keys());
  }
}

/** @deprecated 使用 dnsProviderWhoisRegistry */
export const dnsProviderAdapter = new DnsProviderAdapterRegistry();

function wrapScheduler(scheduler: WhoisScheduler): DnsWhoisSource {
  return {
    type: scheduler.type,
    async query(domain: string, config: any): Promise<WhoisResult | null> {
      try {
        const raw = await scheduler.queryWhois(config, domain);
        if (!raw?.success) return null;
        return convertResult(domain, raw);
      } catch (error) {
        log.error(`DNS provider WHOIS error for ${domain} (${scheduler.type})`, {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
  };
}

function convertResult(domain: string, raw: WhoisSchedulerResult): WhoisResult | null {
  // 不同提供商的到期字段名不一致：DNSHE 原生返回 expires_at，调度器通常已映射成 expiration_date，
  // 但直接调用适配器时不会经过那层映射，这里兜一下，避免到期日被静默丢掉。
  const rawExpiry = raw.expiration_date
    ?? (raw as unknown as { expires_at?: string }).expires_at
    ?? (raw as unknown as { expiry_date?: string }).expiry_date;
  const expiryDate = rawExpiry ? extractExpiryDate(rawExpiry, 'WHOIS') : null;
  return {
    domain,
    expiryDate,
    registrar: raw.registrar || null,
    nameServers: (raw.name_servers || []).map(ns => ns.toLowerCase()),
    raw: raw.raw_data || '',
    status: raw.status ? raw.status.join('\n') : null,
  };
}

// ========== 新统一接口 ==========

export class DnsProviderWhoisRegistry {
  private sources = new Map<string, DnsWhoisSource>();

  registerSource(source: DnsWhoisSource): void {
    if (this.sources.has(source.type)) {
      log.warn(`DNS WHOIS source "${source.type}" already registered, overwriting`);
    }
    this.sources.set(source.type, source);
    log.info(`Registered DNS WHOIS source: ${source.type}`);
  }

  getSource(type: string): DnsWhoisSource | null {
    return this.sources.get(type) || null;
  }

  importFromAdapter(): void {
    for (const type of dnsProviderAdapter.getRegisteredTypes()) {
      const scheduler = dnsProviderAdapter.getAdapter(type);
      if (scheduler && !this.sources.has(type)) {
        this.registerSource(wrapScheduler(scheduler));
      }
    }
  }

  getRegisteredTypes(): string[] {
    return Array.from(this.sources.keys());
  }
}

export const dnsProviderWhoisRegistry = new DnsProviderWhoisRegistry();

export function initDnsProviderWhoisSources(): void {
  dnsProviderWhoisRegistry.importFromAdapter();
  log.info(`Initialized DNS WHOIS sources: ${dnsProviderWhoisRegistry.getRegisteredTypes().join(', ')}`);
}

/** @deprecated 使用 initDnsProviderWhoisSources */
export function initDnsProviderAdapters(): void {
  const { whoisSchedulers } = require('../../../lib/dns/providers');
  for (const scheduler of whoisSchedulers) {
    if (!dnsProviderAdapter.hasAdapter(scheduler.type)) {
      dnsProviderAdapter.register(scheduler);
    }
  }
  dnsProviderWhoisRegistry.importFromAdapter();
  log.info(`Initialized adapters for: ${dnsProviderAdapter.getRegisteredTypes().join(', ') || 'none'}`);
}
