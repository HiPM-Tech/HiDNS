/**
 * WHOIS 查询编排服务
 *
 * 仿照 DnsHelper.ts 模式：
 * - getAdapter() 通过 registry 按需解析适配器
 * - 分层并行竞速策略
 * - 各适配器自带超时，无复杂竞速逻辑
 */

import { WhoisResult, WhoisProviderDefinition, WhoisAdapter } from './types';
import { getAdapter, APEX_PROVIDERS, SUBDOMAIN_PROVIDERS, THIRD_PARTY_PROVIDERS, findProviders, filterByMethod } from './registry';
import { findRdapServer } from './rdap-server-list';
import { getRootDomain } from './domain-utils';
import { dnsProviderWhoisRegistry } from './methods/dns-provider.registry';
import { createLogger } from '../../lib/logger';

const log = createLogger('WhoisService').sub('Lookup');

export interface QueryOptions {
  preferSubdomain?: boolean;
  timeout?: number;
  useCache?: boolean;
  skipParentFallback?: boolean;
  skipUplevel?: boolean;
  /** 指定上游查询模式，多个用数组，默认全部。可选：rdap / whois / http */
  modes?: string[];
}

/** 查询模式名称到内部 method 的映射 */
const MODE_METHOD_MAP: Record<string, string> = {
  rdap: 'rdap',
  whois: 'whois',
  http: 'http-api',
};

function isModeAllowed(method: string, modes?: string[]): boolean {
  if (!modes || modes.length === 0) return true;
  return modes.some(m => MODE_METHOD_MAP[m] === method);
}

export class WhoisLookup {

  async query(domain: string, options: QueryOptions = {}): Promise<WhoisResult | null> {
    const { preferSubdomain = true, timeout = 30000, skipParentFallback = false, skipUplevel = false, modes } = options;

    const rootDomain = getRootDomain(domain);
    const isSub = domain !== rootDomain;

    // 顶域：走 RDAP → WHOIS → DNS → HTTP API → 第三方
    if (!isSub) return this.queryApexOnly(domain, timeout, modes);
    if (skipParentFallback) return this.querySubdomainOnly(domain, timeout, skipUplevel, modes);

    // 子域：DNS Provider 优先
    const dnsResult = await this.queryDnsProvider(domain);
    if (dnsResult?.expiryDate) {
      // 填充顶域到期时间
      const apexResult = await this.queryApexCombined(rootDomain, timeout, modes);
      if (apexResult?.expiryDate) {
        dnsResult.apexExpiryDate = apexResult.expiryDate;
        dnsResult.apexRegistrar = apexResult.registrar;
      }
      return dnsResult;
    }

    // DNS 无结果，走标准协议并行
    const [apexResult, subResult] = await Promise.all([
      this.queryApexCombined(rootDomain, timeout, modes),
      preferSubdomain ? this.querySubdomainCombined(domain, timeout, skipUplevel, modes) : Promise.resolve(null),
    ]);

    if (subResult?.expiryDate) {
      if (apexResult?.expiryDate) {
        subResult.apexExpiryDate = apexResult.expiryDate;
        subResult.apexRegistrar = apexResult.registrar;
      }
      return subResult;
    }

    if (apexResult?.expiryDate) {
      const result: WhoisResult = {
        domain, expiryDate: apexResult.expiryDate, registrar: apexResult.registrar,
        nameServers: apexResult.nameServers, raw: apexResult.raw,
        apexExpiryDate: apexResult.expiryDate, apexRegistrar: apexResult.registrar,
      };
      return result;
    }

    const [rootR, subR] = await Promise.all([
      this.queryThirdParty(rootDomain, timeout, modes),
      domain !== rootDomain ? this.queryThirdParty(domain, timeout, modes) : Promise.resolve(null),
    ]);

    if (subR?.expiryDate) {
      if (rootR?.expiryDate) { subR.apexExpiryDate = rootR.expiryDate; subR.apexRegistrar = rootR.registrar; }
      return subR;
    }
    if (rootR?.expiryDate) {
      const result: WhoisResult = {
        domain, expiryDate: rootR.expiryDate, registrar: rootR.registrar,
        nameServers: rootR.nameServers, raw: rootR.raw,
        apexExpiryDate: rootR.expiryDate, apexRegistrar: rootR.registrar,
      };
      return result;
    }

    return null;
  }

  // ========== DNS 提供商查询 ==========

  /** 查询 DNS 提供商 WHOIS 数据源（需要账号授权配置） */
  private async queryDnsProvider(domain: string): Promise<WhoisResult | null> {
    try {
      const { DomainOperations, DnsAccountOperations } = await import('../../db/bal/business-adapter');
      const domainObj = await DomainOperations.getByName(domain) as any;
      if (!domainObj?.account_id) return null;

      const account = await DnsAccountOperations.getById(domainObj.account_id) as any;
      if (!account?.enabled) return null;

      const source = dnsProviderWhoisRegistry.getSource(account.type as string);
      if (!source) return null;

      const config = typeof account.config === 'string'
        ? JSON.parse(account.config)
        : account.config;

      const result = await source.query(domain, config);
      if (result?.expiryDate) {
        log.info(`[DNS Provider] ${account.type} returned expiry for ${domain}: ${result.expiryDate.toISOString()}`);
      }
      return result;
    } catch (error) {
      log.debug(`[DNS Provider] query failed for ${domain}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // ========== 内部查询 ==========

  /** 顶域：RDAP → WHOIS → DNS Provider → HTTP API → 第三方 */
  private async queryApexOnly(domain: string, timeout: number, modes?: string[]): Promise<WhoisResult | null> {
    let r = await this.queryRegistry(domain, APEX_PROVIDERS, 'rdap', timeout, modes) ||
             await this.queryRegistry(domain, APEX_PROVIDERS, 'whois', timeout, modes);
    if (r?.expiryDate) return r;
    r = await this.queryDnsProvider(domain);
    if (r?.expiryDate) return r;
    r = await this.queryRegistry(domain, APEX_PROVIDERS, 'http-api', timeout, modes);
    if (r?.expiryDate) return r;
    r = await this.queryThirdParty(domain, timeout, modes);
    if (r?.expiryDate) return r;
    return null;
  }

  /** 顶域（填充用）：RDAP → WHOIS → DNS Provider → HTTP API */
  private async queryApexCombined(domain: string, timeout: number, modes?: string[]): Promise<WhoisResult | null> {
    let r = await this.queryRegistry(domain, APEX_PROVIDERS, 'rdap', timeout, modes) ||
             await this.queryRegistry(domain, APEX_PROVIDERS, 'whois', timeout, modes);
    if (r?.expiryDate) return r;
    r = await this.queryDnsProvider(domain);
    if (r?.expiryDate) return r;
    return this.queryRegistry(domain, APEX_PROVIDERS, 'http-api', timeout, modes);
  }

  /** 纯子域查询（skipParentFallback）：DNS → RDAP → WHOIS → HTTP-API → 第三方 */
  private async querySubdomainOnly(domain: string, timeout: number, skipUplevel = false, modes?: string[]): Promise<WhoisResult | null> {
    let r = await this.queryDnsProvider(domain);
    if (r?.expiryDate) return r;

    r = await this.queryRegistry(domain, SUBDOMAIN_PROVIDERS, 'rdap', timeout, modes) ||
        await this.queryRegistry(domain, SUBDOMAIN_PROVIDERS, 'whois', timeout, modes) ||
        await this.queryRegistry(domain, SUBDOMAIN_PROVIDERS, 'http-api', timeout, modes);
    if (r?.expiryDate) return r;

    if (!skipUplevel) {
      r = await this.queryAll(SUBDOMAIN_PROVIDERS, 'rdap', timeout, modes) ||
          await this.queryAll(SUBDOMAIN_PROVIDERS, 'whois', timeout, modes) ||
          await this.queryAll(SUBDOMAIN_PROVIDERS, 'http-api', timeout, modes);
      if (r?.expiryDate) return r;
    }

    r = await this.queryThirdParty(domain, timeout, modes);
    if (r?.expiryDate) return r;
    return null;
  }

  /** 子域并行查询（不含 DNS — 已在 query() 中优先处理） */
  private async querySubdomainCombined(domain: string, timeout: number, skipUplevel = false, modes?: string[]): Promise<WhoisResult | null> {
    const promises = [
      this.queryRegistry(domain, SUBDOMAIN_PROVIDERS, 'rdap', timeout, modes),
      this.queryRegistry(domain, SUBDOMAIN_PROVIDERS, 'whois', timeout, modes),
      this.queryRegistry(domain, SUBDOMAIN_PROVIDERS, 'http-api', timeout, modes),
    ];
    if (!skipUplevel) {
      promises.push(
        this.queryAll(SUBDOMAIN_PROVIDERS, 'rdap', timeout, modes),
        this.queryAll(SUBDOMAIN_PROVIDERS, 'whois', timeout, modes),
        this.queryAll(SUBDOMAIN_PROVIDERS, 'http-api', timeout, modes),
      );
    }
    const results = await Promise.all(promises);
    return results.find(r => r?.expiryDate) || null;
  }

  private async queryThirdParty(domain: string, _timeout: number, modes?: string[]): Promise<WhoisResult | null> {
    return this.queryRegistry(domain, THIRD_PARTY_PROVIDERS, 'rdap', _timeout, modes) ||
           this.queryRegistry(domain, THIRD_PARTY_PROVIDERS, 'whois', _timeout, modes);
  }

  /** 从列表中找匹配的提供商（按 suffix），按 method 筛选，并行查询 */
  private async queryRegistry(
    domain: string, list: WhoisProviderDefinition[], method: string, _timeout?: number, modes?: string[],
  ): Promise<WhoisResult | null> {
    if (!isModeAllowed(method, modes)) return null;
    let providers = filterByMethod(findProviders(list, domain), method as any);

    // 顶域 RDAP：**先**试 IANA 兜底，再判断 providers 是否为空。
    // 之前先把空列表 return 掉，导致 tryIanaRdap 成了死代码——任何没有内置 RDAP 条目的后缀
    // （.site / .de / .fr / .xyz / .top …）都拿不到到期时间（issue #59）。
    if (list === APEX_PROVIDERS && method === 'rdap') {
      const iana = await tryIanaRdap(domain);
      if (iana) {
        // 先用 IANA 给的服务器查一次：即使内置 providers 为空（.site/.de/.fr…）也能拿到结果
        const result = await querySingle(domain, iana);
        if (result?.expiryDate) return result;
      }
      if (providers.length === 0) return null;
    }

    if (providers.length === 0) return null;

    const results = await Promise.all(providers.map(p => querySingle(domain, p)));
    return results.find(r => r?.expiryDate) || null;
  }

  /** 无视 suffix 匹配，使用所有非 noUplevel 提供商（平级查询） */
  private async queryAll(list: WhoisProviderDefinition[], method: string, _timeout?: number, modes?: string[]): Promise<WhoisResult | null> {
    if (!isModeAllowed(method, modes)) return null;
    const providers = filterByMethod(list, method as any).filter(p => !p.noUplevel);
    if (providers.length === 0) return null;
    const results = await Promise.all(providers.map(p => querySingle('', p)));
    return results.find(r => r?.expiryDate) || null;
  }

}

// ========== 独立函数 ==========

async function querySingle(domain: string, def: WhoisProviderDefinition): Promise<WhoisResult | null> {
  try {
    const adapter: WhoisAdapter = getAdapter(def);
    return await adapter.query(domain, def.server);
  } catch {
    return null;
  }
}

async function tryIanaRdap(domain: string): Promise<WhoisProviderDefinition | null> {
  try {
    const tld = domain.toLowerCase().split('.').pop()!;
    const server = await findRdapServer(tld);
    if (server) return { name: `iana-rdap-${tld}`, suffixes: [tld], method: 'rdap', server };
  } catch { /* ignore */ }
  return null;
}

export const whoisLookup = new WhoisLookup();

// 向后兼容
export const whoisService = whoisLookup;

export async function queryWhois(domain: string): Promise<WhoisResult | null> {
  return whoisLookup.query(domain);
}
