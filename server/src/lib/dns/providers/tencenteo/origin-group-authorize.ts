import { AccountContextError, accountAccessLevel, resolveDomainAccount } from '../../account-context';
import type { ExtraAuthorizePrincipal } from '../extra-types';
import { OriginGroupError } from '../../origin-group-core';
import { listTeoZonesByAccount, teoOpsForAccount, teoOpsForDomain } from './origin-group-context';
import { isZoneVisibleCached, resetZoneVisibilityCache } from './zone-visibility-cache';

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


/** 仅供测试清理 */
export function resetZoneAuthorizationCache(): void {
  resetZoneVisibilityCache();
}

async function zoneVisibleUnderCredentials(params: {
  accountId: number;
  siteType: string;
  zoneId: string;
}): Promise<boolean> {
  // 两条凭据路径都要校验。改造前 EdgeOne 账号可以直接 `return true`，
  // 只因为 zoneId 由 domains.third_id 锚定、用户无从指定；账号优先后 scopeId 是用户入参，
  // 那条早退会让「未校验的资源标识直接打上游」，必须删掉。
  //
  // 缓存与账号路径共用同一份实现（zone-visibility-cache），不再各留一个 Map。
  const { visible } = await isZoneVisibleCached(params, () =>
    listTeoZonesByAccount(params.accountId, { siteType: params.siteType }),
  );
  return visible;
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

  // 定位分支（设计 §2.5）：新契约用 accountId + scopeId，旧形态用 domainId。
  // 两者并存 → AMBIGUOUS_LOCATION（不按优先级静默选一个）；都缺 → INVALID_ARGS。
  const rawAccount = args.accountId;
  const rawDomain = args.domainId;
  const hasAccount = rawAccount !== undefined && rawAccount !== null && String(rawAccount).trim() !== '';
  const hasDomain = rawDomain !== undefined && rawDomain !== null && String(rawDomain).trim() !== '';
  if (hasAccount && hasDomain) {
    throw new OriginGroupError(
      'AMBIGUOUS_LOCATION',
      '不能同时指定 accountId 与 domainId：请改用 accountId + scopeId',
    );
  }
  if (!hasAccount && !hasDomain) {
    throw new OriginGroupError('INVALID_ARGS', '缺少定位参数：请给出 accountId + scopeId（旧形态为 domainId）');
  }

  // ① 只解析到「账号」这一层，不碰凭据与站点
  let accountId: number;
  let legacyDomainId: number | undefined;
  if (hasAccount) {
    const parsed = Number(rawAccount);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new OriginGroupError('INVALID_ARGS', 'accountId 必须是正整数');
    }
    accountId = parsed;
  } else {
    legacyDomainId = Number(rawDomain);
    if (!Number.isFinite(legacyDomainId) || legacyDomainId <= 0) {
      throw new OriginGroupError('INVALID_ARGS', '缺少 domainId');
    }
    try {
      accountId = (await resolveDomainAccount(legacyDomainId)).accountId;
    } catch (error) {
      if (error instanceof AccountContextError && error.code === 'DOMAIN_NOT_FOUND') {
        throw new OriginGroupError('NOT_FOUND', '域名不存在或无权访问');
      }
      throw error;
    }
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

  // ③ 写类动作的旧形态拒绝。必须**早于任何凭据解析**：解析会抛可区分他人资源的错误串
  // （PROVIDER_MISMATCH 带提供商类型、CREDENTIAL_REUSE_NOT_DECLARED 带账号类型），
  // 若放在解析之后，未授权者仍能把 accountId/domainId 变成枚举器。
  if (mode === 'write' && legacyDomainId !== undefined) {
    throw new OriginGroupError(
      'LEGACY_WRITE_REJECTED',
      '源站组的写动作要求新契约：请改用 accountId + scopeId（设计 §904）；' +
        '旧形态的 domainId 仅保留给只读动作',
    );
  }

  // ④ 鉴权通过后才解析凭据与站点；此后的错误只可能属于调用者有权访问的资源
  const siteType = String(args.siteType ?? '').trim() || undefined;
  const ctx =
    legacyDomainId !== undefined
      ? await teoOpsForDomain(legacyDomainId, {
          siteType,
          zoneId: String(args.zoneId ?? '').trim() || undefined,
        })
      : await teoOpsForAccount(accountId, {
          siteType,
          zoneId: String(args.scopeId ?? '').trim() || undefined,
        });

  // 作用域归属校验：两条路径各查一次，不重复。
  // - 账号路径：teoOpsForAccount 内部已经做过 `scopeId ∈ listZones(account)`，此处不再重复；
  // - 旧路径：teoOpsForDomain 由 third_id 锚定但**不校验**，必须在这里查（带 60s 缓存）。
  const visible =
    legacyDomainId === undefined
      ? true
      : await zoneVisibleUnderCredentials({
          accountId: ctx.accountId,
          siteType: ctx.siteType,
          zoneId: ctx.zoneId,
        });
  if (!visible) {
    throw new OriginGroupError('ZONE_FORBIDDEN', `该凭据看不到 EdgeOne 站点 ${ctx.zoneId}，拒绝操作`);
  }
}
