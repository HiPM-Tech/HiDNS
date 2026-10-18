import type { ActionDeclaration, BrandedActionHandler } from '../types';
import { defineAction } from '../types';
import { AuthorizationError } from '../../auth';
import { DomainOperations } from '../../../db/bal/business-adapter';

/** 域名列表（只读）。设计依据：§5.3 */
export const dnsDomainActions: ActionDeclaration[] = [
  {
    name: 'dns.domain.list',
    label: 'workflow.action.dns_domain_list',
    actionClass: 'dns.record.read',
    risk: 'low',
    service: 'domains.read',
    dslVisible: true,
    params: [],
  },
];

export const dnsDomainHandlers: Record<string, BrandedActionHandler> = {
  'dns.domain.list': defineAction(async (ctx) => {
    const userId = Number(ctx.principal.id);
    if (!Number.isFinite(userId)) {
      throw new AuthorizationError(401, '缺少可用的用户身份');
    }
    const rows = (await DomainOperations.getUserAccessibleDomains(userId)) as unknown as Array<{
      id: number;
      name: string;
      account_id?: number;
    }>;
    const allowed = ctx.principal.allowedDomains;
    const visible = allowed === '*' ? rows : rows.filter((row) => allowed.includes(row.name));
    return { total: visible.length, domains: visible.map((row) => ({ id: row.id, name: row.name })) };
  }),
};