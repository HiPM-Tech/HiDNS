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
import { authenticatedRequest, ensureCsrfToken, DpdnsAuthConfig } from './auth';

const log = createProviderRenewalLogger('DPDNS');

const BASE_URL = 'https://dash.domain.digitalplat.org/_panel_api';

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
  years: number = 1
): Promise<{ newExpiryDate: string }> {
  // Ensure CSRF token is obtained before mutating request
  await ensureCsrfToken(config);

  const url = `${BASE_URL}/api/domains/${encodeURIComponent(domainName)}/renew`;
  log.sub('API').tag('REQUEST').debug('Renewing domain', { domain: domainName, years });

  const response = await authenticatedRequest(url, config, {
    method: 'POST',
    body: JSON.stringify({
      renewal_type: 'free',
      years,
    }),
  });

  const data: DpdnsRenewResponse = await response.json();

  if (!response.ok || !data.ok) {
    const errMsg = data.error || data.message || `HTTP ${response.status}`;
    log.sub('API').tag('ERROR').error('Renewal failed', { domain: domainName, error: errMsg });
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