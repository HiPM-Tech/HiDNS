import { createProviderAuthLogger, fetchWithFallback } from '../internal';

const log = createProviderAuthLogger('DNSHE');

export interface DnsheAuthConfig {
  apiKey: string;
  apiSecret: string;
  useProxy?: boolean;
}

/**
 * Build authentication headers for DNSHE API
 */
export function buildAuthHeaders(config: DnsheAuthConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-API-Key': config.apiKey,
    'X-API-Secret': config.apiSecret,
  };
}

/**
 * Make an authenticated request to DNSHE API
 */
export async function authenticatedRequest(
  url: string,
  config: DnsheAuthConfig,
  options: RequestInit = {}
): Promise<Response> {
  const headers = {
    ...buildAuthHeaders(config),
    ...options.headers,
  };

  return fetchWithFallback(
    url,
    {
      ...options,
      headers,
    },
    config.useProxy ?? false
  );
}

/**
 * Validate DNSHE credentials
 */
export async function validateCredentials(config: DnsheAuthConfig): Promise<boolean> {
  try {
    const baseUrl = 'https://api005.dnshe.com/index.php';
    const url = `${baseUrl}?m=domain_hub&endpoint=subdomains&action=list`;
    
    const response = await authenticatedRequest(url, config, {
      method: 'GET',
    });

    if (!response.ok) {
      return false;
    }

    // 检查响应内容类型
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      // 如果不是 JSON，可能是 HTML 错误页面
      const text = await response.text();
      log.error('Credential check failed: Expected JSON but got', { contentType });
      log.error('Response preview', { preview: text.substring(0, 200) });
      return false;
    }

    const data = await response.json();
    return data.success === true;
  } catch (error) {
    log.error('Credential check error', { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
