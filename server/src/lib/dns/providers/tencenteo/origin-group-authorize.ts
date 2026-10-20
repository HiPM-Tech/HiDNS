import { AccountContextError, accountAccessLevel, resolveDomainAccount } from '../../account-context';
import type { ExtraAuthorizePrincipal } from '../extra-types';
import { OriginGroupError } from '../../origin-group-core';
import { listTeoZones, teoOpsForDomain } from './origin-group-context';

/**
 * EdgeOne 源站组的站点级授权（实现在提供商目录内，符合 root.ai.md §310）。
 *
 * 源站组**不是域名资源**：它属于 EdgeOne 的「站点」（Zone），一个站点可能根本没有
 * 在 HiDNS 里登记域名，反过来同名域名也不一定是同一个站点。用域名写权限去约束它，
 * 既不对等（有域名权限 ≠ 有站点权限），也会误伤（没有该域名写权限 ≠ 不能管理这个站点）。
 *
 * 顺序很关键：**先鉴权，再解析**。
 * 解析（teoOpsForDomain）会读账号凭据、读站点，并可能抛出带具体标识的错误；
 * 若先解析后鉴权，未授权者就能靠错误串差异探测他人域名是否存在、挂在哪个账号下，
 * 甚至读到他人的 ZoneId。因此这里只先取「域名 → 账号」这一层做判权，通过后才解析。
 *
 * 读与写的准入不同（见 accountAccessLevel 的三态 none/read/write）：
 * 写要求「超管」或「账号创建者且 role >= admin」，团队成员只读 ——
 * 否则被拉进团队的人可以整组覆盖该账号密钥可见的全部站点。
 */

const ZONE_CACHE_TTL_MS = 60_000;
const zoneVisibility = new Map<string, number>();

/** 仅供测试清理 */
export function resetZoneAuthorizationCache(): void {
  zoneVisibility.clear();
}

async function zoneVisibleUnderCredentials(params: {
  domainId: number;
  accountId: number;
  siteType: string;
  zoneId: string;
  credentialSource: 'tencenteo' | 'dnspod';
}): Promise<boolean> {
  // EdgeOne 账号：zoneId 来自该域名的 third_id，本身就属于这个账号，无需再查
  if (params.credentialSource === 'tencenteo') return true;

  const key = `${params.accountId}:${params.siteType}:${params.zoneId}`;
  const hit = zoneVisibility.get(key);
  if (hit !== undefined && Date.now() - hit < ZONE_CACHE_TTL_MS) return true;

  const zones = await listTeoZones(params.domainId, { siteType: params.siteType });
  if (!zones.some((zone) => zone.zoneId === params.zoneId)) return false;
  zoneVisibility.set(key, Date.now());
  return true;
}

export async function authorizeTencenteoOriginGroup(
  principal: ExtraAuthorizePrincipal,
  args: Record<string, unknown>,
  actionClass: string,
): Promise<void> {
  // 非 user 身份（token / system）没有可判定的账号归属，直接拒绝；
  // 单独给错误码，避免以后接入令牌身份时被当成「身份缺失」去查 401。
  if (principal.kind !== 'user') {
    throw new OriginGroupError('PRINCIPAL_KIND_UNSUPPORTED', `不支持的身份类型: ${principal.kind}`);
  }
  const userId = Number(principal.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new OriginGroupError('UNAUTHORIZED', '无法确定执行身份，拒绝操作源站组');
  }

  // 只有显式的 ext.read 才按读处理，其余一律按写（失败关闭）。
  // 不能用 `=== 'ext.write'`，也不能用 `WRITE_ACTION_CLASSES.includes(...)`：
  // 两者对「将来新增的写类分类」都会落成 read，等于默认放行。
  const mode = actionClass === 'ext.read' ? 'read' : 'write';

  const domainId = Number(args.domainId);
  if (!Number.isFinite(domainId) || domainId <= 0) {
    throw new OriginGroupError('INVALID_ARGS', '缺少 domainId');
  }

  // ① 只解析到「账号」这一层，不碰凭据与站点
  let accountId: number;
  try {
    accountId = (await resolveDomainAccount(domainId)).accountId;
  } catch (error) {
    if (error instanceof AccountContextError && error.code === 'DOMAIN_NOT_FOUND') {
      throw new OriginGroupError('NOT_FOUND', '域名不存在或无权访问');
    }
    throw error;
  }

  // ② 判权。分三态，只在「完全无权」与「不存在」之间做等价（防枚举）；
  // 「有读权限但写权限不足」必须可区分 —— 否则团队成员看到「域名不存在」，
  // 而同一工作流的 list 又正常工作，现象自相矛盾、无从诊断。
  const level = await accountAccessLevel({ accountId, userId, role: principal.role });
  if (level === 'none') {
    throw new OriginGroupError('NOT_FOUND', '域名不存在或无权访问');
  }
  if (mode === 'write' && level !== 'write') {
    throw new OriginGroupError(
      'WRITE_FORBIDDEN',
      '你对这个账号只有读权限：改写源站组要求「超管」或「账号创建者且 role >= admin」',
    );
  }

  // ③ 鉴权通过后才解析凭据与站点；此后的错误只可能属于调用者有权访问的资源
  const siteType = String(args.siteType ?? '').trim() || undefined;
  const zoneIdArg = String(args.zoneId ?? '').trim() || undefined;
  const ctx = await teoOpsForDomain(domainId, { siteType, zoneId: zoneIdArg });

  const visible = await zoneVisibleUnderCredentials({
    domainId,
    accountId: ctx.accountId,
    siteType: ctx.siteType,
    zoneId: ctx.zoneId,
    credentialSource: ctx.credentialSource,
  });
  if (!visible) {
    throw new OriginGroupError('ZONE_FORBIDDEN', `该凭据看不到 EdgeOne 站点 ${ctx.zoneId}，拒绝操作`);
  }
}
