/**
 * Proxy HTTP Client
 * 支持代理的 HTTP 客户端工具
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';
import { createLogger } from './logger';
import { SettingsOperations } from '../db/bal/business-adapter';
import { pushHttpProbe } from '../service/resource/cache';

const log = createLogger('ProxyHttp');
// Dynamic imports for proxy agents
let SocksProxyAgent: any;
let HttpsProxyAgent: any;

try {
  const socksModule = require('socks-proxy-agent');
  SocksProxyAgent = socksModule.SocksProxyAgent;
} catch {
  log.warn('socks-proxy-agent not available');
}

try {
  const httpsModule = require('https-proxy-agent');
  HttpsProxyAgent = httpsModule.HttpsProxyAgent;
} catch {
  log.warn('https-proxy-agent not available');
}

/**
 * 代理配置接口
 */
export interface ProxyConfig {
  enabled: boolean;
  type: 'socks5' | 'http';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/**
 * 获取代理配置
 */
export async function getProxyConfig(): Promise<ProxyConfig | null> {
  try {
    const configValue = await SettingsOperations.get('proxy_config');
    if (!configValue) return null;
    return JSON.parse(configValue);
  } catch (error) {
    log.warn('Failed to get proxy config', { error });
    return null;
  }
}

/**
 * 创建代理 Agent
 */
export function createProxyAgent(config: ProxyConfig): any | null {
  if (!config.enabled) return null;

  try {
    if (config.type === 'socks5' && SocksProxyAgent) {
      const auth = config.username && config.password
        ? `${config.username}:${config.password}@`
        : '';
      const proxyUrl = `socks5://${auth}${config.host}:${config.port}`;
      return new SocksProxyAgent(proxyUrl);
    } else if (HttpsProxyAgent) {
      const auth = config.username && config.password
        ? `${config.username}:${config.password}@`
        : '';
      const proxyUrl = `http://${auth}${config.host}:${config.port}`;
      return new HttpsProxyAgent(proxyUrl);
    }
    log.warn('Proxy agent not available');
    return null;
  } catch (error) {
    log.error('Failed to create proxy agent', { error });
    return null;
  }
}

/**
 * 获取代理 Agent（自动从配置创建）
 */
export async function getProxyAgent(): Promise<any | null> {
  const config = await getProxyConfig();
  if (!config || !config.enabled) return null;
  return createProxyAgent(config);
}

/**
 * HTTP 请求选项
 */
export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}

/**
 * 使用代理进行 HTTPS 请求
 */
export function httpsRequest(url: string, options: RequestOptions = {}, agent?: any): Promise<{ status: number; data: string; headers: Record<string, string> }> {
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const requestOptions: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 30000,
    };

    if (agent) {
      requestOptions.agent = agent;
    }

    const req = https.request(requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        pushHttpProbe(Date.now() - startTime);
        resolve({
          status: res.statusCode || 0,
          data,
          headers: res.headers as Record<string, string>,
        });
      });
    });

    req.on('error', (err) => {
      pushHttpProbe(Date.now() - startTime);
      reject(err);
    });
    req.on('timeout', () => {
      pushHttpProbe(Date.now() - startTime);
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

/**
 * 使用代理进行 HTTP 请求
 */
export function httpRequest(url: string, options: RequestOptions = {}, agent?: any): Promise<{ status: number; data: string; headers: Record<string, string> }> {
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const requestOptions: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 80,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 30000,
    };

    if (agent) {
      requestOptions.agent = agent;
    }

    const req = http.request(requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        pushHttpProbe(Date.now() - startTime);
        resolve({
          status: res.statusCode || 0,
          data,
          headers: res.headers as Record<string, string>,
        });
      });
    });

    req.on('error', (err) => {
      pushHttpProbe(Date.now() - startTime);
      reject(err);
    });
    req.on('timeout', () => {
      pushHttpProbe(Date.now() - startTime);
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

/**
 * 自动选择 HTTP/HTTPS 并发送请求
 */
export async function request(url: string, options: RequestOptions = {}): Promise<{ status: number; data: string; headers: Record<string, string> }> {
  const agent = await getProxyAgent();

  if (url.startsWith('https://')) {
    return httpsRequest(url, options, agent);
  } else {
    return httpRequest(url, options, agent);
  }
}

/**
 * 发送 JSON 请求并解析响应
 */
export async function requestJson<T>(url: string, options: RequestOptions = {}): Promise<{ status: number; data: T; headers: Record<string, string> }> {
  const res = await request(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...options.headers,
    },
  });

  let jsonData: T;
  try {
    jsonData = JSON.parse(res.data) as T;
  } catch (error) {
    throw new Error(`Failed to parse JSON response: ${error}`);
  }

  return {
    status: res.status,
    data: jsonData,
    headers: res.headers,
  };
}

/**
 * 兼容 fetch API 的代理请求函数
 * 用于替换 DNS 提供商中的 fetch 调用
 */
export async function fetchWithProxy(url: string, options: RequestInit = {}): Promise<Response> {
  const agent = await getProxyAgent();
  const isHttps = url.startsWith('https://');

  const requestOptions: RequestOptions = {
    method: options.method || 'GET',
    headers: options.headers as Record<string, string> || {},
    body: options.body as string,
    timeout: 30000,
  };

  const res = isHttps
    ? await httpsRequest(url, requestOptions, agent)
    : await httpRequest(url, requestOptions, agent);

  // 构造类似 fetch Response 的对象
  return new Response(res.data, {
    status: res.status,
    headers: res.headers,
  });
}

/**
 * 带自动回退的 fetch 请求函数
 * 先尝试使用代理，如果失败则回退到直连
 * @param useProxy 是否使用代理
 * @param providerName 提供商名称（用于日志）
 */
/**
 * URL 脱敏：把查询串里的凭据类参数打码后再进日志。
 *
 * 有些上游（Dynadot api3）只接受 `?key=...` 形式的凭据，URL 一旦被完整打印就会把密钥写进日志。
 */
export function redactUrl(url: string): string {
  return String(url ?? '').replace(
    /([?&](?:key|api_key|apikey|api_secret|secret|token|access_token|auth)=)[^&]*/gi,
    '$1***',
  );
}

export async function fetchWithFallback(
  url: string,
  options: RequestInit = {},
  useProxy: boolean = false,
  providerName: string = 'Unknown'
): Promise<Response> {
  // 如果不需要代理，直接直连请求
  if (!useProxy) {
    const startTime = Date.now();
    const res = await fetch(url, options);
    pushHttpProbe(Date.now() - startTime);
    return res;
  }

  // 检查全局代理配置是否启用
  const proxyConfig = await getProxyConfig();
  if (!proxyConfig || !proxyConfig.enabled) {
    log.info(`[${providerName}] Proxy not configured or disabled, using direct connection`);
    const startTime = Date.now();
    const res = await fetch(url, options);
    pushHttpProbe(Date.now() - startTime);
    return res;
  }

  // 尝试使用代理（设置较短的超时时间）
  const proxyStartTime = Date.now();
  try {
    log.info(`[${providerName}] Trying proxy request to ${redactUrl(url)}`);
    const agent = createProxyAgent(proxyConfig);
    if (!agent) {
      throw new Error('Failed to create proxy agent');
    }

    const isHttps = url.startsWith('https://');
    const requestOptions: RequestOptions = {
      method: options.method || 'GET',
      headers: options.headers as Record<string, string> || {},
      body: options.body as string,
      timeout: 10000, // 代理超时缩短为 10 秒
    };

    const res = isHttps
      ? await httpsRequest(url, requestOptions, agent)
      : await httpRequest(url, requestOptions, agent);

    const proxyDuration = Date.now() - proxyStartTime;
    log.info(`[${providerName}] Proxy request successful`, { duration: `${proxyDuration}ms` });
    return new Response(res.data, {
      status: res.status,
      headers: res.headers,
    });
  } catch (proxyError) {
    // 代理请求失败，回退到直连
    const proxyDuration = Date.now() - proxyStartTime;
    log.warn(`[${providerName}] Proxy request failed after ${proxyDuration}ms, falling back to direct connection`, {
      error: proxyError instanceof Error ? proxyError.message : String(proxyError)
    });

    const directStartTime = Date.now();
    try {
      const res = await fetch(url, options);
      const directDuration = Date.now() - directStartTime;
      pushHttpProbe(directDuration);
      log.info(`[${providerName}] Direct connection successful`, { duration: `${directDuration}ms` });
      return res;
    } catch (directError) {
      const directDuration = Date.now() - directStartTime;
      pushHttpProbe(directDuration);
      log.error(`[${providerName}] Direct connection also failed after ${directDuration}ms`, {
        error: directError instanceof Error ? directError.message : String(directError)
      });
      throw directError;
    }
  }
}
