import { fetchWithFallback, isTruthyFlag } from '../internal';

export interface CloudflareAuthConfig {
  email?: string;
  apiKey?: string;
  apiToken?: string;
  zoneId?: string;
  domain?: string;
  useProxy?: boolean;
}

/**
 * Build authentication headers for Cloudflare API
 * Supports both API Token and Email+API Key methods
 */
export function buildAuthHeaders(config: CloudflareAuthConfig): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  
  if (config.apiToken) {
    // API Token method (recommended)
    headers['Authorization'] = `Bearer ${config.apiToken}`;
  } else if (config.email && config.apiKey) {
    // Email + Global API Key method (legacy)
    headers['X-Auth-Email'] = config.email;
    headers['X-Auth-Key'] = config.apiKey;
  }
  
  return headers;
}

/**
 * Make an authenticated request to Cloudflare API
 */
export async function authenticatedRequest(
  url: string,
  config: CloudflareAuthConfig,
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
    isTruthyFlag(config.useProxy),
    'Cloudflare'
  );
}

/**
 * Validate Cloudflare credentials by listing zones
 */
export async function validateCredentials(config: CloudflareAuthConfig): Promise<boolean> {
  try {
    const url = 'https://api.cloudflare.com/client/v4/zones?per_page=1';
    
    const response = await authenticatedRequest(url, config, {
      method: 'GET',
    });

    if (!response.ok) {
      return false;
    }

    const data = await response.json();
    return data.success === true;
  } catch {
    return false;
  }
}
