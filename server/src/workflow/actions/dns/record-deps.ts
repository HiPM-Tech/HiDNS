import type { DnsAdapter, DnsRecord, PageResult } from '../../../lib/dns/DnsInterface';
import { DnsProviderService } from '../../../service/dns-provider-service';
import { DomainOperations } from '../../../db/bal/business-adapter';
import { publishRecordEvent } from '../../publish';
import type { ActionContext } from '../../auth';
import { AuthorizationError } from '../../auth';

export interface ResolvedDomain {
  id: number;
  name: string;
  account_id?: number;
}

export interface RecordDeps {
  resolveDomain(ref: { domainId?: number; domainName?: string }): Promise<ResolvedDomain | null>;
  getAdapter(domainId: number): Promise<DnsAdapter>;
  publish: typeof publishRecordEvent;
}

async function defaultResolveDomain(ref: { domainId?: number; domainName?: string }): Promise<ResolvedDomain | null> {
  const row = ref.domainId
    ? await DomainOperations.getById(ref.domainId)
    : ref.domainName
      ? await DomainOperations.getByName(ref.domainName)
      : undefined;
  if (!row) return null;
  const domain = row as unknown as { id: number; name: string; account_id?: number };
  return { id: domain.id, name: domain.name, account_id: domain.account_id };
}

const defaultDeps: RecordDeps = {
  resolveDomain: defaultResolveDomain,
  getAdapter: (domainId) => DnsProviderService.getAdapter(domainId),
  publish: publishRecordEvent,
};

let deps: RecordDeps = defaultDeps;

/** 仅供测试注入 */
export function setRecordDeps(overrides: Partial<RecordDeps>): void {
  deps = { ...defaultDeps, ...overrides };
}

export function resetRecordDeps(): void {
  deps = defaultDeps;
}

/** 单个动作最多影响的记录数（防批量动作打穿配额） */
export const MAX_BATCH_SIZE = 50;

/**
 * 资源级二次校验：即使 authorize 已校验过，handler 仍按解析出的真实域名再验一次。
 * 设计依据：§5.6（DSL 不可越权）与 §5.0（禁止隐式身份）
 */
export function assertDomainAllowed(ctx: ActionContext, domainName: string): void {
  const allowed = ctx.principal.allowedDomains;
  if (allowed === '*') return;
  if (!allowed.includes(domainName)) {
    throw new AuthorizationError(403, `域名权限不足: ${domainName}`);
  }
}

export async function resolveTargetDomain(ctx: ActionContext, args: Record<string, unknown>): Promise<ResolvedDomain> {
  // 显式 args.domain **优先于** 事件资源：否则「A 记录变动 → 更新 B 域名的记录」
  // 这类跨域名写入会被静默改成操作事件来源域名（§4.0.4 允许的替代路径之一）。
  const explicitName = typeof args.domain === 'string' && args.domain ? args.domain : undefined;
  const ref = explicitName
    ? { domainName: explicitName }
    : { domainId: ctx.resource?.domainId, domainName: ctx.resource?.domainName };
  if (!ref.domainId && !ref.domainName) {
    throw new AuthorizationError(400, '缺少目标域名');
  }
  const domain = await deps.resolveDomain(ref);
  if (!domain) throw new AuthorizationError(404, '目标域名不存在或不可见');
  assertDomainAllowed(ctx, domain.name);
  return domain;
}

export async function getAdapterFor(domain: ResolvedDomain): Promise<DnsAdapter> {
  return deps.getAdapter(domain.id);
}

export function emitRecordEvent(input: Parameters<typeof publishRecordEvent>[0]): void {
  deps.publish(input);
}

export function toRecordDto(record: DnsRecord): Record<string, unknown> {
  return {
    recordId: record.RecordId,
    name: record.Name,
    type: record.Type,
    value: record.Value,
    ttl: record.TTL,
    line: record.Line,
    status: record.Status,
  };
}

export type { PageResult };