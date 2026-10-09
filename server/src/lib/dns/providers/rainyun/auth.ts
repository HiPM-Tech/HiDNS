import { fetchWithFallback } from '../internal';

export interface RainyunAuthConfig {
  apiKey: string;
  useProxy?: boolean;
}

/**
 * Build authentication headers for RAINYUN API
 */
export function buildAuthHeaders(config: RainyunAuthConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': config.apiKey,
  };
}

/**
 * Make an authenticated request to RAINYUN API
 */
export async function authenticatedRequest(
  url: string,
  config: RainyunAuthConfig,
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
 * Validate RAINYUN credentials
 */
export async function validateCredentials(config: RainyunAuthConfig): Promise<boolean> {
  try {
    // TODO: Implement credential validation
    return true;
  } catch {
    return false;
  }
}
