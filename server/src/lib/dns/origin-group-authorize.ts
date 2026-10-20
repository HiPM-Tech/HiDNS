import { DnsAccountOperations, TeamOperations } from '../../db/bal/business-adapter';
import { isAtLeast, ROLE_ADMIN } from '../../utils/roles';
import type { ExtraAuthorizePrincipal } from './providers/extra-types';
import { OriginGroupError } from './origin-group-core';
import { listTeoZones, teoOpsForDomain } from './origin-group-broker';

/**
 * EdgeOne 源站组的站点级授权。
 *
 * 源站组**不是域名资源**：它属于 EdgeOne 的"站点"（Zone），一个站点可能根本没有
 * 在 HiDNS 里登记域名，反过来同名域名也不一定是同一个站点。用域名写权限去约束它，
 * 既不对等（有域名权限 ≠ 有站点权限），也会误伤（没有该域名写权限 ≠ 不能管理这个站点）。
 *
 * 判定分两步，任何一步无法确定都**失败关闭**：
 *   1. 用户能否访问提供凭据的 DNS 账号（超管 / 账号所有者 / 账号所属团队成员）
 *   2. 该站点是否在此账号凭据的可见范围内
 *
 * 第 2 步对 EdgeOne 账号天然成立（zoneId 取自该域名的 third_id，本就是该账号下的站点），
 * 对复用 DNSPod 凭据的情况则必须核验——否则用户可以传任意 zoneId 让我们去操作。
 * 核验结果缓存 60 秒，避免每个动作都打一次 DescribeZones。
 */

const ZONE_CACHE_TTL_MS = 60_000;
const zoneVisibility = new Map<string, number>();

/** 仅供测试清理 */
export function resetZoneAuthorizationCache(): void {
  zoneVisibility.clear();
}

/**
 * 用户能否以指定模式使用该账号的凭据。
 *
 * **读与写必须分开**：源站组整组覆盖是 ext.write，若与读共用同一条判定，
 * 就等于把「能看这个账号」放大成「能改写该账号密钥可见的全部站点」。
 * 写口径与 routes/accounts.ts 的 canManageAccount 对齐：
 * 超管，或「账号创建者且 role >= admin」；团队成员只读。
 */
async function canAccessAccount(
  accountId: number,
  userId: number,
  role: string,
  mode: 'read' | 'write',
): Promise<boolean> {
  // 超管本来就拥有全部账号；这里只对非超管做实质判定
  if (role === 'super_admin') return true;
  const account = (await DnsAccountOperations.getById(accountId)) as unknown as
    | { created_by?: number; team_id?: number | null }
    | undefined;
  if (!account) return false;

  if (Number(account.created_by) === userId) {
    // 读：创建者即可；写：还必须是 admin 及以上
    return mode === 'read' ? true : isAtLeast(role, ROLE_ADMIN);
  }

  // 团队成员只有读权限。写必须由账号创建者发起 —— 否则被拉进团队的人
  // 可以整组覆盖该账号密钥可见的所有 EdgeOne 站点（评审 P0）。
  return mode === 'read' && Boolean(account.team_id) && TeamOperations.isMember(Number(account.team_id), userId);
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
  // 读、写两类动作的准入不同：写必须由账号创建者发起（见 canAccessAccount）
  const mode: 'read' | 'write' = actionClass === 'ext.write' ? 'write' : 'read';

  const domainId = Number(args.domainId);
  if (!Number.isFinite(domainId) || domainId <= 0) {
    throw new OriginGroupError('INVALID_ARGS', '缺少 domainId');
  }

  const siteType = String(args.siteType ?? '').trim() || undefined;
  const zoneIdArg = String(args.zoneId ?? '').trim() || undefined;

  // 解析过程会给出真实的 accountId / zoneId / 凭据来源；解析失败本身就是拒绝
  const ctx = await teoOpsForDomain(domainId, { siteType, zoneId: zoneIdArg });

  if (!(await canAccessAccount(ctx.accountId, userId, principal.role, mode))) {
    throw new OriginGroupError(
      'ACCOUNT_FORBIDDEN',
      mode === 'write'
        ? `无权以写模式使用该 DNS 账号（#${ctx.accountId}）：改写源站组要求「超管」或「账号创建者且 role >= admin」`
        : `无权使用该 DNS 账号（#${ctx.accountId}）的凭据操作 EdgeOne 源站组`,
    );
  }

  const visible = await zoneVisibleUnderCredentials({
    domainId,
    accountId: ctx.accountId,
    siteType: ctx.siteType,
    zoneId: ctx.zoneId,
    credentialSource: ctx.credentialSource,
  });
  if (!visible) {
    throw new OriginGroupError(
      'ZONE_FORBIDDEN',
      `该凭据看不到 EdgeOne 站点 ${ctx.zoneId}，拒绝操作`,
    );
  }
}
