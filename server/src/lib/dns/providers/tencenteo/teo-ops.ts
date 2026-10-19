import { DnsProviderService } from '../../../../service/dns-provider-service';
import { DnsAccountOperations, DomainOperations } from '../../../../db/bal/business-adapter';
import { TencenteoAdapter } from './adapter';
import type { OriginGroupClient } from './origin-group-client';
import { OriginGroupError } from './origin-group';

/**
 * 由域名解析出可用的 EdgeOne 源站组客户端。
 *
 * 两条路径：
 * 1. **EdgeOne 账号**：`domains.third_id` 就是 ZoneId，直接用
 * 2. **DNSPod 账号**：EO 与 DNSPod 用的是同一对腾讯云 SecretId/SecretKey，
 *    因此可以复用 DNSPod 账号的凭据调用 TEO。但此时 `third_id` 是 DNSPod 的域名 ID，
 *    不能当 ZoneId，必须拿域名去 TEO 侧精确反查。
 *
 * 复用凭据的前提是这对密钥本身拥有 EdgeOne 权限；没有权限时 TEO 会返回
 * AuthFailure，这里统一翻译成可读错误，而不是把底层报文抛给用户。
 *
 * 能力层（ext 动作）与候选源（编辑器下拉）都走这里，避免两处各写一遍鉴权逻辑。
 */

export type CredentialSource = 'tencenteo' | 'dnspod';

export interface TeoOps {
  ops: OriginGroupClient;
  credentialSource: CredentialSource;
  zoneId: string;
  domainName: string;
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

export async function teoOpsForDomain(domainId: number): Promise<TeoOps> {
  if (!Number.isFinite(domainId) || domainId <= 0) {
    throw new OriginGroupError('INVALID_ARGS', '缺少 domainId');
  }
  const domain = (await DomainOperations.getById(domainId)) as unknown as
    | { id: number; name: string; account_id: number; third_id?: string }
    | undefined;
  if (!domain) throw new OriginGroupError('DOMAIN_NOT_FOUND', '域名不存在');

  const accountId = Number(domain.account_id);
  const domainName = String(domain.name ?? '');
  const adapter = await DnsProviderService.getAdapterByAccount(accountId);

  if (adapter instanceof TencenteoAdapter) {
    const zoneId = String(domain.third_id ?? '');
    adapter.setZoneInfo(zoneId, domainName);
    return { ops: adapter.originGroups(), credentialSource: 'tencenteo', zoneId, domainName };
  }

  const account = (await DnsAccountOperations.getById(accountId)) as unknown as
    | { type?: string; config?: unknown }
    | undefined;
  if (!account || String(account.type ?? '') !== 'dnspod') {
    throw new OriginGroupError(
      'PROVIDER_MISMATCH',
      '该域名的提供商不是 EdgeOne，也不是可复用腾讯云鉴权的 DNSPod 账号',
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

  const teo = new TencenteoAdapter({
    SecretId: secretId,
    SecretKey: secretKey,
    site_type: String(config.site_type ?? 'mainland'),
  });
  let zoneId: string | null;
  try {
    zoneId = await teo.resolveZoneIdByName(domainName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new OriginGroupError(
      'EDGEONE_ACCESS_DENIED',
      `复用 DNSPod 凭据调用 EdgeOne 失败（该密钥可能没有 EdgeOne 权限）: ${message}`,
    );
  }
  if (!zoneId) {
    throw new OriginGroupError('ZONE_NOT_FOUND', `域名 ${domainName} 未接入 EdgeOne`);
  }
  teo.setZoneInfo(zoneId, domainName);
  return { ops: teo.originGroups(), credentialSource: 'dnspod', zoneId, domainName };
}
