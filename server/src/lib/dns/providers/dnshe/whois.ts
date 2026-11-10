import { createProviderWhoisLogger } from '../internal';
import { authenticatedRequest, DnsheAuthConfig } from './auth';

const log = createProviderWhoisLogger('DNSHE');
export interface DnsheWhoisResult {
  success: boolean;
  message?: string;
  domain: string;
  expires_at?: string;
  registrar?: string;
  status?: string;
  [key: string]: any;
}

/**
 * Get WHOIS information for a DNSHE domain
 */
export async function getWhois(
  config: DnsheAuthConfig,
  domain: string
): Promise<DnsheWhoisResult | null> {
  try {
    const baseUrl = 'https://api005.dnshe.com/index.php';
    const url = `${baseUrl}?m=domain_hub&endpoint=whois&domain=${encodeURIComponent(domain)}`;

    log.sub('API').tag('REQUEST').debug('Provider request', { method: 'GET', url: 'whois', params: { domain } });

    const response = await authenticatedRequest(url, config, {
      method: 'GET',
    });

    if (!response.ok) {
      const text = await response.text();
      log.sub('API').tag('ERROR').error('Provider error', {
        status: response.status,
        error: `WHOIS request failed: ${text}`
      });
      return null;
    }

    const data = await response.json();
    // 关键字段摘要（不打印整包）：到期日缺失时，靠这几个字段判断是「上游没给」还是「字段名/格式不对」
    log.sub('API').tag('RESPONSE').debug('Provider response', {
      status: response.status,
      success: data.success,
      expires: data.expires_at ?? data.expiration_date ?? data.expiry_date ?? null,
      registrar: data.registrar ?? null,
      domainStatus: data.status ?? null,
      keys: Object.keys(data).slice(0, 12),
    });

    if (!data.success) {
      log.sub('API').tag('ERROR').error('Provider error', { message: data.message || data.error });
      return null;
    }

    return data as DnsheWhoisResult;
  } catch (error) {
    log.sub('API').tag('ERROR').error('Provider error', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
