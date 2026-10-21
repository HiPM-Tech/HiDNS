import { AccountContextError, resolveAccount, resolveAdapter, resolveDomainAccount } from '../../account-context';
import { TencenteoAdapter } from './adapter';
import type { OriginGroupClient } from './origin-group-client';
import { OriginGroupError } from '../../origin-group-core';
import { mayReuseCredentials } from '../credential-sharing';
import { getOriginGroupCapability } from '../registry';
import { isZoneVisibleCached } from './zone-visibility-cache';
import { normalizeProviderType } from '../../providerAlias';

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
  /** 作用域名（仅用于日志与结果回显；账号优先下没有域名，存站点名） */
  scopeName: string;
  /** 实际使用的调用站点类型，写操作据此可追溯调的是哪个端点 */
  siteType: SiteType;
}

export interface TeoOpsOptions {
  /** 站点类型，仅**复用 DNSPod 凭据**时需要；EdgeOne 账号直接复用账号配置 */
  siteType?: string;
  /**
   * EdgeOne ZoneId。复用 DNSPod 凭据时**必需**（DNSPod 域名与 EO 站点无对应关系）；
   * EdgeOne 账号下若传入且与 third_id 不一致，会报 ZONE_ID_IGNORED。
   */
  zoneId?: string;
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
  // 域名与账号的读取走 DNS 模块子功能（account-context），本文件不直接依赖 BAL。
  // 只把「行不存在」映射成业务错误；DB 故障 / 连接池耗尽必须原样上抛，
  // 否则运维看到的是「域名不存在」，排查方向会被彻底带偏。
  try {
    const ref = await resolveDomainAccount(domainId);
    return { accountId: ref.accountId, domainName: ref.domainName, thirdId: ref.thirdId };
  } catch (error) {
    if (error instanceof AccountContextError && error.code === 'DOMAIN_NOT_FOUND') {
      throw new OriginGroupError('DOMAIN_NOT_FOUND', '域名不存在');
    }
    throw error;
  }
}

/** 取账号行；只有「账号不存在」映射成业务错误，其余故障原样上抛 */
async function requireAccount(
  accountId: number,
): Promise<{ accountType: string; accountConfig: Record<string, string> }> {
  try {
    return await resolveAccount(accountId);
  } catch (error) {
    if (error instanceof AccountContextError && error.code === 'ACCOUNT_NOT_FOUND') {
      throw new OriginGroupError('PROVIDER_MISMATCH', '该域名的提供商不是 EdgeOne，也没有找到可复用凭据的账号');
    }
    throw error;
  }
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
  account: { accountType: string; accountConfig: Record<string, string> },
  options: TeoOpsOptions,
): Promise<{ adapter: TencenteoAdapter; siteType: SiteType }> {
  // 凭据复用必须**双向声明**：导出方允许谁用、消费方要用谁的，两边都命中才放行。
  // 只由本文件单方面判断"可以吃 dnspod 的凭据"是不安全的——那样任何提供商实现
  // 只要写死同样一句，就能拿到别的提供商的 SecretId / SecretKey。
  // 历史账号行可能存的是 lego 别名（tencentcloud / edgeone 等），
  // 归一化后再比对，避免把「配置写法不同」报成「授权未声明」。
  const accountType = normalizeProviderType(account.accountType);
  if (!mayReuseCredentials('tencenteo', accountType)) {
    throw new OriginGroupError(
      'CREDENTIAL_REUSE_NOT_DECLARED',
      `不允许复用「${accountType || '(未知)'}」提供商的凭据调用 EdgeOne：` +
        '跨提供商凭据复用需要两端相互声明（导出方允许 + 消费方申请），当前声明不成立',
    );
  }

  const config = account.accountConfig;
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
  const adapter = await resolveAdapter(domain.accountId);

  if (adapter instanceof TencenteoAdapter) {
    // EdgeOne 账号：third_id 就是 ZoneId，site_type 取自账号配置，不需要额外声明。
    // 若调用方还传了 zoneId，说明它以为自己在指定站点 —— 但这条路径根本不用它。
    // 静默忽略会让「账号类型从 dnspod 换成 tencenteo」后的旧工作流悄悄改打到另一个站点，
    // 所以这里显式报错，让人重新确认参数。
    const explicitZone = String(options.zoneId ?? '').trim();
    if (explicitZone && explicitZone !== domain.thirdId) {
      throw new OriginGroupError(
        'ZONE_ID_IGNORED',
        // 不回显 domain.thirdId：错误串会落进 workflow_runs.error 并返回给 owner，
        // 等于把他人站点的 ZoneId 送出去。
        '该域名属于 EdgeOne 账号，ZoneId 由账号配置决定，传入的 zoneId 不会生效；请移除该参数',
      );
    }
    adapter.setZoneInfo(domain.thirdId, domain.domainName);
    return {
      ops: adapter.originGroups(),
      credentialSource: 'tencenteo',
      accountId: domain.accountId,
      zoneId: domain.thirdId,
      scopeName: domain.domainName,
      siteType: adapter.getSiteType(),
    };
  }

  const account = await requireAccount(domain.accountId);
  const { adapter: teo, siteType } = await buildReusedAdapter(account, options);

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
    scopeName: domain.domainName,
    siteType,
  };
}

/** 列出当前域名所属账号的密钥可见的 EdgeOne 站点（供编辑器下拉选择 zoneId） */
export async function listTeoZones(
  domainId: number,
  options: TeoOpsOptions = {},
): Promise<Array<{ zoneId: string; zoneName: string }>> {
  const domain = await resolveDomain(domainId);
  const adapter = await resolveAdapter(domain.accountId);

  if (adapter instanceof TencenteoAdapter) {
    // EdgeOne 账号的 ZoneId 由域名自身决定，没有「选站点」这回事。
    // 只返回本域名的站点：否则编辑器会列出该凭据可见的全部站点，
    // 用户选中别的站点后只能在执行期撞 ZONE_ID_IGNORED。
    return [{ zoneId: domain.thirdId, zoneName: domain.domainName }];
  }

  const account = await requireAccount(domain.accountId);
  const { adapter: teo } = await buildReusedAdapter(account, options);
  return teo.listZones();
}

/**
 * 账号优先的解析入口（设计 §3.7.8）。
 *
 * 与 `teoOpsForDomain` 共用 `buildReusedAdapter` / `requireSiteType`，差异只在**作用域从哪来**：
 * 域名入口由 `domains.third_id` 单值锚定；账号入口由调用方显式给出 `scopeId`。
 *
 * 两条凭据路径都做**作用域归属校验**（`scopeId ∈ listZones(account)`）：
 * 改造前 tencenteo 账号不需要校验，只因为 zone 由域名锚定、用户无从指定；
 * 账号优先后 scopeId 是用户入参，这条早退必须删掉，否则等于「未校验的资源标识直接打上游」。
 */
export async function teoOpsForAccount(accountId: number, options: TeoOpsOptions = {}): Promise<TeoOps> {
  if (!Number.isFinite(accountId) || accountId <= 0) {
    throw new OriginGroupError('INVALID_ARGS', '缺少 accountId');
  }
  const scopeId = String(options.zoneId ?? '').trim();
  if (!scopeId) {
    throw new OriginGroupError('SCOPE_ID_REQUIRED', '账号优先需要显式给出作用域（scopeId）');
  }

  const adapter = await resolveAdapter(accountId);

  if (adapter instanceof TencenteoAdapter) {
    const siteType = adapter.getSiteType();
    // 走 60s 缓存：否则每次动作都要 DescribeZones（100 条/页），事件触发时极易撞上游限流
    const { visible, zoneName } = await isZoneVisibleCached(
      { accountId, siteType, zoneId: scopeId },
      () => adapter.listZones(),
    );
    if (!visible) {
      // 不回显他人站点标识：错误串会落进 workflow_runs.error 并返回给 owner
      throw new OriginGroupError('NOT_FOUND', '作用域不属于该账号');
    }
    adapter.setZoneInfo(scopeId, zoneName || scopeId);
    return {
      ops: adapter.originGroups(),
      credentialSource: 'tencenteo',
      accountId,
      zoneId: scopeId,
      scopeName: zoneName || scopeId,
      siteType: adapter.getSiteType(),
    };
  }

  const account = await requireAccount(accountId);
  const { adapter: teo, siteType } = await buildReusedAdapter(account, options);
  const { visible, zoneName } = await isZoneVisibleCached(
    { accountId, siteType, zoneId: scopeId },
    () => teo.listZones(),
  );
  if (!visible) {
    throw new OriginGroupError('NOT_FOUND', '作用域不属于该账号');
  }
  teo.setZoneInfo(scopeId, zoneName || scopeId);
  return {
    ops: teo.originGroups(),
    credentialSource: 'dnspod',
    accountId,
    zoneId: scopeId,
    scopeName: zoneName || scopeId,
    siteType,
  };
}

/** 按**账号**列出凭据可见的 EdgeOne 站点（候选源用；与 teoOpsForAccount 共用同一份可见性口径） */
export async function listTeoZonesByAccount(
  accountId: number,
  options: TeoOpsOptions = {},
): Promise<Array<{ zoneId: string; zoneName: string }>> {
  const adapter = await resolveAdapter(accountId);
  if (adapter instanceof TencenteoAdapter) return adapter.listZones();
  const account = await requireAccount(accountId);
  const { adapter: teo } = await buildReusedAdapter(account, options);
  return teo.listZones();
}


