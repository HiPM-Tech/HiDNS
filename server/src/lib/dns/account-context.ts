import { DnsProviderService } from '../../service/dns-provider-service';
import { DnsAccountOperations, DomainOperations, TeamOperations } from '../../db/bal/business-adapter';
import type { DnsAdapter } from './DnsInterface';

/**
 * 账号上下文解析（DNS 模块子功能）。
 *
 * 为什么单独抽出来：提供商实现（`providers/**`）不应该直接依赖业务适配层（BAL）
 * 与服务层 —— 那是上层的事。提供商只该懂"怎么调厂商 API"，不该懂"凭据存在哪张表里"。
 *
 * 这里集中承担三件事，供能力层与候选源共用：
 *   1. domainId → 域名行 → accountId（BAL）
 *   2. accountId → 账号行（BAL）
 *   3. accountId → 适配器实例（service）
 *
 * 依赖方向因此变成：providers ← lib/dns（本文件）→ BAL / service，
 * 而不是 providers → BAL / service。
 */

/** 带 code 的解析错误：调用方只映射「不存在」，其余（DB 故障等）原样上抛 */
export class AccountContextError extends Error {
  constructor(
    readonly code: 'DOMAIN_NOT_FOUND' | 'ACCOUNT_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'AccountContextError';
  }
}

export interface AccountContext {
  domainId: number;
  domainName: string;
  /** 上游作用域标识：EdgeOne 账号下就是 ZoneId；DNSPod 账号下是 DNSPod 的域名 ID */
  thirdId: string;
  accountId: number;
  accountType: string;
  accountConfig: Record<string, string>;
  adapter: DnsAdapter;
}

/** 账号配置在库里是 JSON 字符串；损坏时按空对象处理，不阻塞调用方 */
function parseAccountConfig(raw: unknown): Record<string, string> {
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

export interface DomainRef {
  domainId: number;
  domainName: string;
  thirdId: string;
  accountId: number;
}

/** 只解析域名 → 账号，不构造适配器（供需要账号信息但不需要适配器的场景） */
export async function resolveDomainAccount(domainId: number): Promise<DomainRef> {
  const domain = (await DomainOperations.getById(domainId)) as unknown as
    | { id: number; name: string; account_id: number; third_id?: string }
    | undefined;
  if (!domain) {
    throw new AccountContextError('DOMAIN_NOT_FOUND', `域名不存在: #${domainId}`);
  }
  return {
    domainId: Number(domain.id ?? domainId),
    domainName: String(domain.name ?? ''),
    thirdId: String(domain.third_id ?? ''),
    accountId: Number(domain.account_id),
  };
}

/** 解析账号行（类型 + 配置） */
export async function resolveAccount(
  accountId: number,
): Promise<{ accountId: number; accountType: string; accountConfig: Record<string, string> }> {
  const account = (await DnsAccountOperations.getById(accountId)) as unknown as
    | { type?: string; config?: unknown }
    | undefined;
  if (!account) {
    throw new AccountContextError('ACCOUNT_NOT_FOUND', `DNS 账号不存在: #${accountId}`);
  }
  return {
    accountId,
    accountType: String(account.type ?? ''),
    accountConfig: parseAccountConfig(account.config),
  };
}

/** 适配器实例（对 service 层的唯一出口，供不需要账号行的场景使用） */
export async function resolveAdapter(accountId: number): Promise<DnsAdapter> {
  return DnsProviderService.getAdapterByAccount(accountId);
}

/** 完整上下文：域名 + 账号 + 适配器 */
export async function resolveAccountContext(domainId: number): Promise<AccountContext> {
  const ref = await resolveDomainAccount(domainId);
  const account = await resolveAccount(ref.accountId);
  const adapter = await DnsProviderService.getAdapterByAccount(ref.accountId);
  return { ...ref, ...account, adapter };
}

export type AccessMode = 'read' | 'write';

/**
 * 用户能否以指定模式使用某个账号（数据访问层，供能力层调用）。
 *
 * 放在这里而不是提供商目录：它要读账号行（BAL），而提供商不得直接依赖 BAL。
 * 授权**策略**留在提供商的能力层，**数据**在这里。
 *
 * 返回三态而不是布尔：调用方需要区分「完全无权（可伪装成不存在）」与
 * 「有读权限但写权限不足（应当明确告知）」，否则一次过度模糊会让
 * 有读权限的人拿到「域名不存在」，运维无从诊断。
 *
 * 读 = 账号创建者 / 账号所属团队成员 / 超管
 * 写 = 超管 /（账号创建者 且 角色为 admin 或 super_admin）
 *      —— 与 routes/accounts.ts 的 canManageAccount 同口径；团队成员只读。
 * 账号停用时三态一律为 none（含超管）。
 *
 * role 传入的是 workflow 的角色词表（'user' | 'admin' | 'super_admin'），
 * **不要**喂给 utils/roles 的数值词表（normalizeRole 不认 'super_admin'）。
 */
export type AccessLevel = 'none' | 'read' | 'write';

export async function accountAccessLevel(params: {
  accountId: number;
  userId: number;
  role: string;
}): Promise<AccessLevel> {
  const { accountId, userId, role } = params;
  const account = (await DnsAccountOperations.getById(accountId)) as unknown as
    | { created_by?: number; team_id?: number | null; enabled?: number | boolean }
    | undefined;
  if (!account) return 'none';

  // 账号停用一律拒绝，**包括超管**：与 routes/domains.ts 的 resolveDomainAccess
  // （先判 enabled 再判 isSuper）和 getUserAccessibleDomains 的 enabled = 1 过滤一致。
  if (Number(account.enabled) === 0) return 'none';

  if (role === 'super_admin') return 'write';

  const isCreator = Number(account.created_by) === userId;
  if (isCreator) return role === 'admin' || role === 'super_admin' ? 'write' : 'read';

  // 团队成员只读：否则被拉进团队的人可以整组覆盖该账号可见的全部站点。
  if (account.team_id && (await TeamOperations.isMember(Number(account.team_id), userId))) return 'read';
  return 'none';
}
