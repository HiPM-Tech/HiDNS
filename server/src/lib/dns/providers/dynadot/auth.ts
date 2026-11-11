import crypto from 'node:crypto';
import { createProviderAuthLogger, fetchWithFallback, isTruthyFlag, safeString } from '../internal';

const log = createProviderAuthLogger('Dynadot');

export const DYNADOT_BASE_URL = 'https://api.dynadot.com';
/** v2 只用主版本号（次版本向后兼容），完整路径形如 /restful/v2/domains/{name}/dns */
export const DYNADOT_API_PREFIX = '/restful/v2';

export interface DynadotAuthConfig {
  apiKey: string;
  apiSecret: string;
  useProxy?: boolean;
}

export function resolveDynadotConfig(config: Record<string, unknown>): DynadotAuthConfig {
  return {
    // UI 用 apiKey/apiSecret；兼容历史写法 apikey/apisecret
    apiKey: safeString(config.apiKey) || safeString(config.apikey),
    apiSecret: safeString(config.apiSecret) || safeString(config.apisecret),
    useProxy: isTruthyFlag(config.useProxy),
  };
}

export interface DynadotRequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** 事务性请求（写入 / 读敏感信息）默认签名；只读列表可传 false */
  signed?: boolean;
}

/**
 * 文档 §X-Signature：
 *   stringToSign = apiKey + 换行 + fullPathAndQuery + 换行 + (xRequestId 或空) + 换行 + (请求体 或空)
 *   X-Signature  = Base64(HMAC-SHA256(secret, stringToSign))
 * 注意编码是 **Base64**，不是 hex。
 */
export function buildStringToSign(apiKey: string, pathAndQuery: string, requestBody = '', requestId = ''): string {
  return [apiKey, pathAndQuery, requestId, requestBody].join('\n');
}

export function buildSignature(apiKey: string, apiSecret: string, pathAndQuery: string, requestBody = '', requestId = ''): string {
  const stringToSign = buildStringToSign(apiKey, pathAndQuery, requestBody, requestId);
  return crypto.createHmac('sha256', apiSecret).update(stringToSign, 'utf8').digest('base64');
}

export async function dynadotRequest<T>(
  config: DynadotAuthConfig,
  method: string,
  path: string,
  options: DynadotRequestOptions = {},
): Promise<T> {
  if (!config.apiKey || !config.apiSecret) {
    throw new Error('Dynadot 未配置 API Key / API Secret');
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  const pathAndQuery = `${DYNADOT_API_PREFIX}${path}${query ? `?${query}` : ''}`;
  const requestBody = options.body === undefined ? '' : JSON.stringify(options.body);
  const requestId = crypto.randomUUID();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    Accept: 'application/json',
    'X-Request-ID': requestId,
  };
  if (options.signed !== false) {
    headers['X-Signature'] = buildSignature(config.apiKey, config.apiSecret, pathAndQuery, requestBody, requestId);
  }
  if (requestBody) headers['Content-Type'] = 'application/json';

  log.sub('API').tag('REQUEST').debug('Provider request', {
    method,
    path: pathAndQuery,
    signed: options.signed !== false,
  });

  const res = await fetchWithFallback(
    `${DYNADOT_BASE_URL}${pathAndQuery}`,
    { method, headers, ...(requestBody ? { body: requestBody } : {}) },
    config.useProxy ?? false,
    'Dynadot',
  );

  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }

  if (!res.ok) {
    const payload = (data ?? {}) as Record<string, unknown>;
    const detail = safeString(payload.message) || safeString(payload.error) || safeString(payload.detail) || text.slice(0, 160);
    throw new Error(`Dynadot 请求失败（HTTP ${res.status}）：${detail || '无响应内容'}`);
  }

  log.sub('API').tag('RESPONSE').debug('Provider response', { status: res.status });
  return data as T;
}