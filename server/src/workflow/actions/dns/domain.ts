import type { ActionDeclaration, BrandedActionHandler } from '../types';
import { defineAction, ActionNotImplementedError } from '../types';

export const dnsDomainActions: ActionDeclaration[] = [
  { name: 'dns.domain.list', label: 'workflow.action.dns_domain_list', actionClass: 'dns.record.read', risk: 'low', service: 'domains.read', dslVisible: true, params: [] },
];

export const dnsDomainHandlers: Record<string, BrandedActionHandler> = {
  'dns.domain.list': defineAction(async () => {
    throw new ActionNotImplementedError('dns.domain.list');
  }),
};
