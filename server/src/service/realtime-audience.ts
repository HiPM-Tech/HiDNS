import {
  DnsAccountOperations,
  DomainOperations,
  DomainPermissionOperations,
  TeamOperations,
  UserOperations,
} from '../db/bal/business-adapter';
import { ROLE_ADMIN, ROLE_SUPER } from '../utils/roles';
import { createLogger } from '../lib/logger';

const log = createLogger('Realtime').sub('Audience');

/**
 * WebSocket 定向推送的收件人集合。
 *
 * 为什么单独抽一层：`wsService.broadcast` 是全局广播，任何带域名标识的事件一旦走全局
 * 广播，就等于把他人域名（名称、到期时间、监控归属）推给所有在线客户端。
 *
 * 口径基准是 HTTP 读权限 `routes/domains.ts` 的 `resolveDomainAccess`（第 77-110 行），
 * 逐条对齐：
 *   A) 账号不存在或 `enabled === 0` → 对**所有人**拒绝（含超管）；
 *   B) 超管放行；
 *   C) 账号创建者**且**其角色 >= admin 才放行；
 *   D) 只有 `hasRules` 为真时才按 `domain_permissions` 的用户行/团队行判定；
 *   E) `hasRules` 为假时即便表里有残留授权行也不生效。
 * 多算 = 跨用户外泄；少算 = 用户看得到却收不到实时更新。两条都不允许。
 *
 * 已知取舍：本文件与 `routes/domains.ts` 是同一口径的两份实现。抽公共函数需要改
 * `routes/domains.ts`（当前写入范围之外），因此这里把基准行号写进注释，改动基准时必须
 * 两边同步；后续若拿到 routes 的写入范围，应把它上提成 service 层共用判定。
 */

/** 特权名单缓存 60s：一次 WHOIS 同步会遍历全部域名，逐域名查用户表会退化成 N 次全表扫 */
const PRIVILEGED_TTL_MS = 60_000;

interface PrivilegedUsers {
  /** role_level >= admin 且未停用 */
  readonly admins: ReadonlySet<number>;
  /** role_level >= super 且未停用 */
  readonly supers: ReadonlySet<number>;
  readonly at: number;
}

let privilegedCache: PrivilegedUsers | null = null;

export function resetRealtimeAudienceCache(): void {
  privilegedCache = null;
}

/**
 * 一次性读出特权用户集合，避免逐域名查用户表。
 * `UserOperations.getAll()` 的 SELECT 列表不含 password_hash（见 business-adapter 的 users 查询），
 * 本函数只在进程内使用、不落日志不落响应。
 */
async function loadPrivilegedUsers(): Promise<PrivilegedUsers> {
  const now = Date.now();
  if (privilegedCache && now - privilegedCache.at < PRIVILEGED_TTL_MS) return privilegedCache;

  const admins = new Set<number>();
  const supers = new Set<number>();
  try {
    const users = (await UserOperations.getAll()) as Array<{
      id?: number;
      role_level?: number;
      role?: number;
      status?: number;
    }>;
    for (const user of users) {
      const id = Number(user.id);
      if (!Number.isFinite(id) || id <= 0) continue;
      // 停用账号不参与推送：登录态可能残留，宁可不推
      if (Number(user.status) !== 1) continue;
      // 用户表的查询把 role_level 同时投影成 role，两者缺失才算无名角色
      const level = Number(user.role_level ?? user.role ?? 0);
      if (level >= ROLE_SUPER) {
        supers.add(id);
        admins.add(id);
        continue;
      }
      if (level >= ROLE_ADMIN) admins.add(id);
    }
  } catch (error) {
    // fail-closed 且不写缓存：算不出特权用户就当没有，下次调用重试
    log.error('load privileged users failed', { error: (error as Error).message });
    return { admins, supers, at: 0 };
  }

  privilegedCache = { admins, supers, at: now };
  return privilegedCache;
}

/** 超管用户 ID（`role_level >= 3` 且账号未停用） */
export async function getSuperAdminUserIds(): Promise<number[]> {
  return [...(await loadPrivilegedUsers()).supers];
}

/**
 * 能读到该域名的用户 ID 集合（含超管）。
 * 查询失败返回空集：客户端仍有列表刷新/轮询兜底，不得因为查不到而无差别广播。
 */
export async function getDomainAudienceUserIds(domainId: number): Promise<number[]> {
  if (!Number.isFinite(domainId) || domainId <= 0) return [];

  const audience = new Set<number>();
  const add = (value: unknown): void => {
    const id = Number(value);
    if (Number.isFinite(id) && id > 0) audience.add(id);
  };

  try {
    const domain = (await DomainOperations.getById(domainId)) as
      | { id?: number; account_id?: number }
      | undefined;
    if (!domain || !domain.account_id) return [];

    const account = (await DnsAccountOperations.getById(Number(domain.account_id))) as
      | { created_by?: number; enabled?: number | boolean }
      | undefined;
    // A) 账号缺失或已禁用 → 全员不可读（含超管），与 routes/domains.ts:80-83 一致
    if (!account) return [];
    if (account.enabled === 0 || account.enabled === false) return [];

    const privileged = await loadPrivilegedUsers();

    // C) 创建者旁路必须同时满足「是创建者」与「角色 >= admin」
    const createdBy = Number(account.created_by);
    if (privileged.admins.has(createdBy)) add(createdBy);

    // D/E) 只有存在授权规则时才按规则收集；无规则时残留行不生效
    if (await DomainPermissionOperations.hasRules(domainId)) {
      const permissions = (await DomainPermissionOperations.getByDomainId(domainId)) as Array<{
        user_id?: number | null;
        team_id?: number | null;
        permission?: string | null;
      }>;
      const teamIds = new Set<number>();
      for (const row of permissions) {
        // 与 HTTP 读判定（routes/domains.ts 的 resolveDomainAccess）逐字对齐：
        // 只有 read/write 取值的行才算授权。permission 列没有 CHECK 约束，
        // 不过滤会让 permission='deny' 的授权行反而把人加进收件人（多算=外泄）。
        if (row.permission !== undefined && row.permission !== null
          && row.permission !== 'read' && row.permission !== 'write') {
          continue;
        }
        add(row.user_id);
        const teamId = Number(row.team_id);
        if (Number.isFinite(teamId) && teamId > 0) teamIds.add(teamId);
      }

      // 团队授权对成员生效：只按 team_id 收集会整段漏掉「团队共享域名」的成员
      for (const teamId of teamIds) {
        const members = (await TeamOperations.getMembers(teamId)) as Array<{ user_id?: number }>;
        for (const member of members) add(member.user_id);
      }
    }

    // B) 超管对可读域名一律 canRead，收尾统一加入，避免被 hasRules 分支漏掉
    for (const id of privileged.supers) add(id);

    return [...audience];
  } catch (error) {
    log.error('getDomainAudienceUserIds failed', { domainId, error: (error as Error).message });
    return [];
  }
}
