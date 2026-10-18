import { fetchWithFallback } from '../../../lib/proxy-http';
import { createLogger } from '../../../lib/logger';
import type { ActionDeclaration, BrandedActionHandler } from '../types';
import { defineAction } from '../types';
import { DEFAULT_HTTP_POLICY, validateOutboundUrl, type HttpFetchPolicy } from './policy';

const log = createLogger('Workflow').sub('Http');

export const httpOutboundActions: ActionDeclaration[] = [
  {
    name: 'http.outbound.fetch',
    label: 'workflow.action.http_outbound_fetch',
    actionClass: 'http',
    risk: 'medium',
    service: 'network.fetch',
    dslVisible: true,
    params: [
      { key: 'url', label: 'workflow.param.url', type: 'text', required: true },
      { key: 'method', label: 'workflow.param.method', type: 'select', required: false, options: ['GET', 'POST'] },
    ],
  },
];

export interface OutboundResult {
  status: number;
  url: string;
  headers: Record<string, string>;
  text: string;
  truncated: boolean;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

let currentPolicy: HttpFetchPolicy = DEFAULT_HTTP_POLICY;

/** 由管理员设置装载；测试可注入 */
export function setHttpFetchPolicy(policy: Partial<HttpFetchPolicy>): void {
  currentPolicy = { ...DEFAULT_HTTP_POLICY, ...policy };
}

export function getHttpFetchPolicy(): HttpFetchPolicy {
  return currentPolicy;
}

export class OutboundRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OutboundRejectedError';
  }
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * 出站请求：协议白名单 + 域名白名单 + 内网拒绝 + 逐跳重定向校验 + 大小与超时上限。
 * 设计依据：docs/WORKFLOW_ENGINE_DESIGN.md §5.5
 */
export async function fetchOutbound(
  rawUrl: string,
  options: { method?: string; policy?: HttpFetchPolicy; fetcher?: Fetcher } = {},
): Promise<OutboundResult> {
  const policy = options.policy ?? currentPolicy;
  const fetcher = options.fetcher ?? ((url, init) => fetchWithFallback(url, init));
  const method = (options.method ?? 'GET').toUpperCase();

  if (method !== 'GET' && method !== 'POST') {
    throw new OutboundRejectedError('METHOD_DENIED', `方法不允许: ${method}`);
  }

  let currentUrl = rawUrl;
  for (let hop = 0; hop <= policy.maxRedirects; hop += 1) {
    const { url, rejection } = validateOutboundUrl(currentUrl, policy);
    if (rejection || !url) {
      throw new OutboundRejectedError(rejection?.code ?? 'INVALID_URL', rejection?.message ?? 'URL 非法');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
    let response: Response;
    try {
      response = await fetcher(url.toString(), {
        method,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      throw new OutboundRejectedError('FETCH_FAILED', (error as Error).message);
    }
    clearTimeout(timer);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new OutboundRejectedError('REDIRECT_WITHOUT_LOCATION', '重定向缺少 Location');
      }
      currentUrl = new URL(location, url).toString();
      continue;
    }

    const buffer = await response.arrayBuffer();
    const truncated = buffer.byteLength > policy.maxBytes;
    const slice = truncated ? buffer.slice(0, policy.maxBytes) : buffer;
    const text = new TextDecoder('utf-8', { fatal: false }).decode(slice);

    log.debug('outbound fetch ok', { host: url.hostname, status: response.status, bytes: buffer.byteLength });

    return {
      status: response.status,
      url: url.toString(),
      headers: headersToObject(response.headers),
      text,
      truncated,
    };
  }

  throw new OutboundRejectedError('TOO_MANY_REDIRECTS', `重定向超过 ${policy.maxRedirects} 次`);
}

export const httpOutboundHandlers: Record<string, BrandedActionHandler> = {
  'http.outbound.fetch': defineAction(async (_ctx, args) => {
    const url = String(args.url ?? '');
    const method = typeof args.method === 'string' ? args.method : 'GET';
    const result = await fetchOutbound(url, { method });
    return { status: result.status, url: result.url, text: result.text, truncated: result.truncated };
  }),
};