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
    description: 'workflow.actionDesc.http_outbound_fetch',
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

/**
 * 流式读取响应体并在超过上限时立即中止。
 * 不整体 arrayBuffer 后再截断 —— 那等于先把 20MB 读进内存再丢掉。
 */
async function readBodyCapped(
  response: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const body = response.body;
  if (!body) {
    const buffer = await response.arrayBuffer();
    const truncated = buffer.byteLength > maxBytes;
    const slice = truncated ? buffer.slice(0, maxBytes) : buffer;
    return { text: new TextDecoder('utf-8', { fatal: false }).decode(slice), bytes: buffer.byteLength, truncated };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > maxBytes) {
      const keep = Math.max(0, maxBytes - (received - value.byteLength));
      if (keep > 0) chunks.push(value.subarray(0, keep));
      truncated = true;
      // 立即中止连接，不再继续下载
      controller.abort();
      try { await reader.cancel(); } catch { /* 忽略 */ }
      break;
    }
    chunks.push(value);
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    text: new TextDecoder('utf-8', { fatal: false }).decode(merged),
    bytes: received,
    truncated,
  };
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
  options: {
    method?: string;
    policy?: HttpFetchPolicy;
    fetcher?: Fetcher;
    /** 运行级 signal：整体超时后必须能让出站 I/O 一起停下 */
    signal?: AbortSignal;
  } = {},
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
    // 外部（运行级）signal 与本跳的控制器合并：任一触发即中止
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    // 超时必须覆盖**整个请求生命周期**（含 body 读取），否则慢速响应体可绕过超时
    const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetcher(url.toString(), {
          method,
          redirect: 'manual',
          signal,
        });
      } catch (error) {
        throw new OutboundRejectedError('FETCH_FAILED', (error as Error).message);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        // 早退前必须释放连接，否则重定向链会堆积未消费的响应体
        await response.body?.cancel().catch(() => undefined);
        if (!location) {
          throw new OutboundRejectedError('REDIRECT_WITHOUT_LOCATION', '重定向缺少 Location');
        }
        currentUrl = new URL(location, url).toString();
        continue;
      }

      // 先按 Content-Length 预检，避免明知超限还整段读入
      const declared = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > policy.maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new OutboundRejectedError('RESPONSE_TOO_LARGE', `响应体超过 ${policy.maxBytes} 字节`);
      }

      let text: string;
      let bytes: number;
      let truncated: boolean;
      try {
        ({ text, bytes, truncated } = await readBodyCapped(response, policy.maxBytes, controller));
      } catch (error) {
        // 超时打断读取时抛的是原始 AbortError，必须映射成可判定的错误码
        if ((error as Error).name === 'AbortError') {
          throw new OutboundRejectedError('TIMEOUT', `出站请求超时（>${policy.timeoutMs}ms）`);
        }
        throw error;
      }

      log.debug('outbound fetch ok', { host: url.hostname, status: response.status, bytes });

      return {
        status: response.status,
        url: url.toString(),
        headers: headersToObject(response.headers),
        text,
        truncated,
      };
    } finally {
      clearTimeout(timer);
    }

  }

  throw new OutboundRejectedError('TOO_MANY_REDIRECTS', `重定向超过 ${policy.maxRedirects} 次`);
}

export const httpOutboundHandlers: Record<string, BrandedActionHandler> = {
  'http.outbound.fetch': defineAction(async (ctx, args) => {
    const url = String(args.url ?? '');
    const method = typeof args.method === 'string' ? args.method : 'GET';
    const result = await fetchOutbound(url, { method, signal: ctx.signal });
    return { status: result.status, url: result.url, text: result.text, truncated: result.truncated };
  }),
};