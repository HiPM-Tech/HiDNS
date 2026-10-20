import { DnsProviderService } from '../../../../service/dns-provider-service';
import { DnsAccountOperations, DomainOperations } from '../../../../db/bal/business-adapter';
import { TencenteoAdapter } from './adapter';
import type { OriginGroupClient } from './origin-group-client';
import { OriginGroupError } from './origin-group';
import { mayReuseCredentials } from '../credential-sharing';

/**
 * 由域名解析出可用的 EdgeOne 源站组客户端。
 *
 * 两条路径：
 * 1. **EdgeOne 账号**：`domains.third_id` 就是 ZoneId，直接用，不需要额外声明
 * 2. **DNSPod 账号**：EO 与 DNSPod 用的是同一对腾讯云 SecretId/SecretKey，
 *    因此可以复用 DNSPod 账号的凭据调用 TEO。
 *
 *    但要注意：**DNSPod 注册的域名与 EdgeOne 站点没有对应关系**。
 *    不能拿 HiDNS 里的域名去 EO 侧反查 ZoneId —— 那只是把"域名看起来一样"
 *    当成了"就是同一个站点"，一旦用户的 EO 站点用了别的名字，就会静默落空。
 *    所以复用凭据时必须**显式给出 EdgeOne ZoneId**（站点类型同理）。
 *
 * 复用凭据的前提是这对密钥本身拥有 EdgeOne 权限；没有权限时 TEO 会返回
 * AuthFailure，这里统一翻译成可读错误，而不是把底层报文抛给用户。
 *
 * 能力层（ext 动作）与候选源（编辑器下拉）都走这里，避免两处各写一遍鉴权逻辑。
 */

export type CredentialSource = 'tencenteo' | 'dnspod';

/**
 * EdgeOne 的调用域名按站点类型区分，两者**不互通**：
 * - `mainland`：teo.tencentcloudapi.com
 * - `intl`：teo.intl.tencentcloudapi.com
 *
 * 拿国内站域名去查国际站账号，只会得到空列表或 AuthFailure，
 * 表现为"域名未接入 EdgeOne"这种误导性错误。所以这里不接受默认值，
 * 必须由调用方显式声明。
 */
export type SiteType = 'mainland' | 'intl';

export const SITE_TYPES: readonly SiteType[] = ['mainland', 'intl'];

export function normalizeSiteType(raw: unknown): SiteType | null {
  const value = String(raw ?? '').trim().toLowerCase();
  return value === 'mainland' || value === 'intl' ? value : null;
}

export interface TeoOps {
  ops: OriginGroupClient;
  credentialSource: CredentialSource;
  /** 提供凭据的 DNS 账号；站点级授权据此判断用户是否有权使用该账号 */
  accountId: number;
  zoneId: string;
  domainName: string;
  /** 实际使用的调用站点类型，写操作据此可追溯调的是哪个端点 */
  siteType: SiteType;
}

export interface TeoOpsOptions {
  /** 站点类型，仅**复用 DNSPod 凭据**时需要；EdgeOne 账号直接复用账号配置 */
  siteType?: string;
  /** EdgeOne ZoneId，仅**复用 DNSPod 凭据**时需要（DNSPod 域名与 EO 站点无对应关系） */
  zoneId?: string;
}

export function parseAccountConfig(raw: unknown): Record<string, string> {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? (raw as Record<string, string>) : {};
}

interface ResolvedDomain {
  accountId: number;
  domainName: string;
  thirdId: string;
}

async function resolveDomain(domainId: number): Promise<ResolvedDomain> {
  if (!Number.isFinite(domainId) || domainId <= 0) {
    throw new OriginGroupError('INVALID_ARGS', '缺少 domainId');
  }
  const domain = (await DomainOperations.getById(domainId)) as unknown as
    | { id: number; name: string; account_id: number; third_id?: string }
    | undefined;
  if (!domain) throw new OriginGroupError('DOMAIN_NOT_FOUND', '域名不存在');
  return {
    accountId: Number(domain.account_id),
    domainName: String(domain.name ?? ''),
    thirdId: String(domain.third_id ?? ''),
  };
}

function requireSiteType(raw: unknown): SiteType {
  if (raw === undefined || String(raw).trim() === '') {
    throw new OriginGroupError(
      'SITE_TYPE_REQUIRED',
      '复用 DNSPod 账号调用 EdgeOne 时必须显式声明站点类型：在工作流动作里传 siteType=mainland 或 intl。' +
        '国内站与国际站是不同的调用域名，无法自动推断，也不会默认成任何一个。',
    );
  }
  const siteType = normalizeSiteType(raw);
  if (!siteType) {
    throw new OriginGroupError('SITE_TYPE_INVALID', `站点类型 ${String(raw)} 无效，只能是 mainland 或 intl`);
  }
  return siteType;
}

/**
 * 用 DNSPod 账号的腾讯云密钥构造一个只用于 EdgeOne 的适配器。
 * 这里只取 SecretId / SecretKey，不涉及任何 DNSPod 注册的域名。
 */
async function buildReusedAdapter(
  accountId: number,
  options: TeoOpsOptions,
): Promise<{ adapter: TencenteoAdapter; siteType: SiteType }> {
  const account = (await DnsAccountOperations.getById(accountId)) as unknown as
    | { type?: string; config?: unknown }
    | undefined;
  if (!account) {
    throw new OriginGroupError('PROVIDER_MISMATCH', '该域名的提供商不是 EdgeOne，也没有找到可复用凭据的账号');
  }

  // 凭据复用必须**双向声明**：导出方允许谁用、消费方要用谁的，两边都命中才放行。
  // 只由本文件单方面判断"可以吃 dnspod 的凭据"是不安全的——那样任何提供商实现
  // 只要写死同样一句，就能拿到别的提供商的 SecretId / SecretKey。
  const accountType = String(account.type ?? '');
  if (!mayReuseCredentials('tencenteo', accountType)) {
    throw new OriginGroupError(
      'CREDENTIAL_REUSE_NOT_DECLARED',
      `不允许复用「${accountType || '(未知)'}」提供商的凭据调用 EdgeOne：` +
        '跨提供商凭据复用需要两端相互声明（导出方允许 + 消费方申请），当前声明不成立',
    );
  }

  const config = parseAccountConfig(account.config);
  const secretId = String(config.SecretId ?? '');
  const secretKey = String(config.SecretKey ?? '');
  if (!secretId || !secretKey) {
    throw new OriginGroupError(
      'CREDENTIAL_MISSING',
      'DNSPod 账号缺少 SecretId / SecretKey，无法复用其鉴权调用 EdgeOne',
    );
  }

  const siteType = requireSiteType(options.siteType);
  return {
    adapter: new TencenteoAdapter({ SecretId: secretId, SecretKey: secretKey, site_type: siteType }),
    siteType,
  };
}

export async function teoOpsForDomain(domainId: number, options: TeoOpsOptions = {}): Promise<TeoOps> {
  const domain = await resolveDomain(domainId);
  const adapter = await DnsProviderService.getAdapterByAccount(domain.accountId);

  if (adapter instanceof TencenteoAdapter) {
    // EdgeOne 账号：third_id 就是 ZoneId，site_type 取自账号配置，不需要额外声明
    adapter.setZoneInfo(domain.thirdId, domain.domainName);
    return {
      ops: adapter.originGroups(),
      credentialSource: 'tencenteo',
      accountId: domain.accountId,
      zoneId: domain.thirdId,
      domainName: domain.domainName,
      siteType: adapter.getSiteType(),
    };
  }

  const { adapter: teo, siteType } = await buildReusedAdapter(domain.accountId, options);

  // DNSPod 注册的域名与 EdgeOne 站点没有对应关系，不能按域名反查。
  const zoneId = String(options.zoneId ?? '').trim();
  if (!zoneId) {
    throw new OriginGroupError(
      'ZONE_ID_REQUIRED',
      '复用 DNSPod 凭据时必须显式给出 EdgeOne ZoneId（zoneId 参数）：' +
        'DNSPod 注册的域名与 EdgeOne 站点没有对应关系，无法从域名推导。' +
        '可先用 edgeoneZones 候选源列出当前凭据可见的站点。',
    );
  }

  teo.setZoneInfo(zoneId, domain.domainName);
  return {
    ops: teo.originGroups(),
    credentialSource: 'dnspod',
    accountId: domain.accountId,
    zoneId,
    domainName: domain.domainName,
    siteType,
  };
}

/** 列出当前域名所属账号的密钥可见的 EdgeOne 站点（供编辑器下拉选择 zoneId） */
export async function listTeoZones(
  domainId: number,
  options: TeoOpsOptions = {},
): Promise<Array<{ zoneId: string; zoneName: string }>> {
  const domain = await resolveDomain(domainId);
  const adapter = await DnsProviderService.getAdapterByAccount(domain.accountId);

  if (adapter instanceof TencenteoAdapter) {
    return adapter.listZones();
  }

  const { adapter: teo } = await buildReusedAdapter(domain.accountId, options);
  return teo.listZones();
}
