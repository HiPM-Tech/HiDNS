/**
 * ⚠️ DigitalPlat Domains (dpdns) 域名续期 API — 逆向实现
 *
 * 通过逆向 web 控制台 REST API 实现的 free 域名续期功能。
 * 仅支持 free 配额的域名：
 *   - 列出账号下所有 slot_type === 'free' 的域名
 *   - 对 free 域名执行 free 续期（剩余 <= 120 天才能续期）
 *
 * ⚠️ 注意：未来将添加 dodns 提供商（官方 API key 实现），
 *    届时两个提供商将并存于注册表中。
 */

import { createProviderRenewalLogger } from '../internal';
import { authenticatedRequest, ensureCsrfToken, loginWithPasskey, resolveSessionJar, send, DPDNS_BASE_URL, DpdnsAuthConfig } from './auth';

const log = createProviderRenewalLogger('DPDNS');

// 必须与换签（auth.ts）用同一个主机：
// 会话 cookie 是在 dashboard.digitalplat.org 下发的，发到 dash.domain.digitalplat.org
// 会因为域不匹配导致 CSRF 校验直接失败（400 Invalid CSRF token）。
const BASE_URL = `${DPDNS_BASE_URL}/_panel_api`;

// ============================================================================
// 类型定义
// ============================================================================

/** API 返回的域名对象（原始字段） */
export interface DpdnsDomain {
  domain: string;
  status: string;
  zone: string;
  registrar: string;
  dns_server: string | null;
  dns_provider: string | null;
  registration_date: string;   // YYYYMMDD
  expiry_date: string;         // YYYYMMDD
  nameservers: string[];
  registrant: string;
  slot_type: 'free' | 'paid' | 'subscription';
  lifecycle_type: string;
  subscription_stage: string | null;
  subscription_status: string | null;
  subscription_warning: string | null;
  can_manual_renew: boolean;
  can_convert_to_permanent: boolean;
  conversion_cost_cents: number;
  dns_active: boolean;
  whois_privacy: string;
  whois_privacy_enabled: boolean;
  pending_delete_release_at: string | null;
}

/** 域名列表 API 响应 */
interface DpdnsDomainListResponse {
  ok: boolean;
  domains: DpdnsDomain[];
}

/** 续期 API 响应 */
interface DpdnsRenewResponse {
  ok: boolean;
  message?: string;
  error?: string;
}

// ============================================================================
// API 调用
// ============================================================================

/**
 * 拉取全部域名。
 *
 * 失败时必须**抛错**，不能折叠成空数组（root.ai.md §DNS接口定义 2.1：读接口 fail-closed）。
 * 空数组会被上层当成「账号下没有域名」，在域名同步里等于把本地域名全部禁用。
 */
async function fetchAllDomains(
  config: DpdnsAuthConfig
): Promise<DpdnsDomain[]> {
  const url = `${BASE_URL}/api/domains`;
  log.sub('API').tag('REQUEST').debug('Fetching domain list');

  const response = await authenticatedRequest(url, config, { method: 'GET' });

  if (!response.ok) {
    log.sub('API').tag('ERROR').error('Failed to fetch domains', { status: response.status });
    throw new Error(`获取域名列表失败（HTTP ${response.status}）`);
  }

  const data = await response.json().catch(() => null) as DpdnsDomainListResponse | null;

  if (!data?.ok || !Array.isArray(data.domains)) {
    log.sub('API').tag('ERROR').error('Invalid API response');
    throw new Error('上游域名列表响应格式异常');
  }

  return data.domains;
}

/**
 * 返回所有域名（不限配额类型）
 */
export async function listAllDomains(
  config: DpdnsAuthConfig
): Promise<DpdnsDomain[]> {
  const domains = await fetchAllDomains(config);
  log.sub('API').tag('SUCCESS').debug('Fetched all domains', {
    total: domains.length,
  });
  return domains;
}

/**
 * 获取所有 free 域名列表
 * 自动过滤 slot_type === 'free' 且 can_manual_renew === true 的域名
 */
export async function listFreeDomains(
  config: DpdnsAuthConfig
): Promise<DpdnsDomain[]> {
  const domains = await fetchAllDomains(config);

  const freeDomains = domains.filter(
    (d) => d.slot_type === 'free' && d.can_manual_renew
  );

  log.sub('API').tag('SUCCESS').debug('Fetched free domains', {
    total: domains.length,
    freeCount: freeDomains.length,
  });

  return freeDomains;
}

/**
 * 执行 free 续期
 *
 * API 限制：
 *   - 域名剩余到期时间必须 <= 120 天
 *   - 仅支持 slot_type === 'free' 的域名
 *
 * @returns 续期后的新到期日（ISO 格式），失败返回 null
 */
export async function renewFreeDomain(
  config: DpdnsAuthConfig,
  domainName: string,
  years: number = 1,
  /** 内部用：CSRF 失败换签后只重试一次，避免无限递归 */
  retried = false,
): Promise<{ newExpiryDate: string }> {
  // 只在完全没有 token 时才去取。
  // 实测：每次 GET /api/security/csrf 都会让服务端轮换会话里的 CSRF，
  // 而轮换后的值既不是旧 cookie 也不是返回的 body —— 多余的刷新会把本来能用的 token 弄失效。
  if (!config.csrfToken) {
    // 优先用会话 cookie 里已有的 token（DB 里存的 sessionCookie 就带着它），
    // 这样完全不用发请求；只有连 cookie 里都没有时才去取。
    // 关键：登录态下 GET /api/security/csrf 会重设会话 cookie，把刚换签的登录态冲掉。
    const jarToken = resolveSessionJar(config).get('panel_csrf_token');
    if (jarToken) config.csrfToken = jarToken;
    else await ensureCsrfToken(config);
  }

  const url = `${BASE_URL}/api/domains/${encodeURIComponent(domainName)}/renew`;
  log.sub('API').tag('REQUEST').debug('Renewing domain', { domain: domainName, years });

  const payload = JSON.stringify({ renewal_type: 'free', years });

  // 直接用 send 发一次，不经过 authenticatedRequest：后者的 ensureSession 会先打 /auth/me，
  // 在「DB 里的会话已过期」场景下会先换签再重发，把刚建立的会话又绕一圈（实测反而 400 CSRF）。
  // 这里按「浏览器同款」的顺序：带现有 sessionCookie 与 token 直接 POST；
  // 只有真的 401 / CSRF 失败时才换签并重发一次。
  log.sub('API').tag('TRACE').debug('Renew request context', {
    url,
    csrf: config.csrfToken ? `${config.csrfToken.slice(0, 6)}…` : '(none)',
    cookieCsrf: (String(config.sessionCookie ?? '').match(/panel_csrf_token=([^;]+)/)?.[1] ?? '-').slice(0, 6),
    cookies: Object.keys(Object.fromEntries(String(config.sessionCookie ?? '').split('; ').filter(Boolean).map((p) => [p.split('=')[0], 1]))).join(','),
  });

  let response = await send(url, config, { method: 'POST', body: payload });
  let data: DpdnsRenewResponse = await response.clone().json().catch(() => ({ ok: false } as DpdnsRenewResponse));

  if (response.status === 401 || (!data.ok && /csrf/i.test(String(data.error ?? '')))) {
    log.sub('API').tag('FALLBACK').warn('Renewal needs re-sign, retrying once', { domain: domainName });
    await loginWithPasskey(config);
    response = await send(url, config, { method: 'POST', body: payload });
    data = await response.clone().json().catch(() => ({ ok: false } as DpdnsRenewResponse));
  }

  if (!response.ok || !data.ok) {
    const errMsg = data.error || data.message || `HTTP ${response.status}`;

    // 带上 CSRF 现场：header 里的 token 前缀 + 当前 cookie 名，用于判断两者是否同源
    const cookieNames = Object.keys(Object.fromEntries(
      (config.sessionCookie ?? '')
        .split('; ')
        .filter(Boolean)
        .map((pair) => [pair.split('=')[0], 1]),
    )).join(',');
    log.sub('API').tag('ERROR').error('Renewal failed', {
      domain: domainName,
      error: errMsg,
      status: response.status,
      csrfHeader: config.csrfToken ? `${config.csrfToken.slice(0, 6)}…` : '(none)',
      csrfCookie: (String(config.sessionCookie ?? '').match(/panel_csrf_token=([^;]+)/)?.[1] ?? '').slice(0, 6) + '…',
      cookieNames: cookieNames || '(none)',
    });
    throw new Error(errMsg);
  }

  // 续期成功后，重新查询域名信息以获取新的到期日
  const updatedDomain = await getDomainInfo(config, domainName);
  if (updatedDomain) {
    const newExpiry = parseDpdnsDate(updatedDomain.expiry_date);
    log.sub('API').tag('SUCCESS').info('Domain renewed successfully', {
      domain: domainName,
      newExpiryDate: newExpiry,
    });
    return { newExpiryDate: newExpiry };
  }

  // 如果无法获取新到期日，至少返回成功
  return { newExpiryDate: '' };
}

/**
 * 获取单个域名详情
 */
async function getDomainInfo(
  config: DpdnsAuthConfig,
  domainName: string
): Promise<DpdnsDomain | null> {
  try {
    const url = `${BASE_URL}/api/domains/${encodeURIComponent(domainName)}`;
    const response = await authenticatedRequest(url, config, { method: 'GET' });

    if (!response.ok) return null;

    const data = await response.json();
    return data?.domain || null;
  } catch {
    return null;
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 将 dpdns 的 YYYYMMDD 格式日期解析为 MySQL/SQLite 兼容的日期字符串
 */
export function parseDpdnsDate(dateStr: string): string {
  if (!dateStr || dateStr.length !== 8) return '';
  try {
    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(4, 6);
    const day = dateStr.substring(6, 8);
    return `${year}-${month}-${day} 23:59:59`;
  } catch {
    return '';
  }
}

/**
 * 计算当前日期到到期日之间的剩余天数
 */
export function getDaysUntilExpiry(expiryDateStr: string): number | null {
  if (!expiryDateStr || expiryDateStr.length !== 8) return null;
  try {
    const year = parseInt(expiryDateStr.substring(0, 4), 10);
    const month = parseInt(expiryDateStr.substring(4, 6), 10) - 1;
    const day = parseInt(expiryDateStr.substring(6, 8), 10);
    const expiry = new Date(year, month, day);
    const now = new Date();
    return Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  } catch {
    return null;
  }
}