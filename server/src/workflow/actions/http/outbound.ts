import type { ActionDeclaration, BrandedActionHandler } from '../types';
import { defineAction, ActionNotImplementedError } from '../types';

export const httpOutboundActions: ActionDeclaration[] = [
  { name: 'http.outbound.fetch', label: 'workflow.action.http_outbound_fetch', actionClass: 'http', risk: 'medium', service: 'network.fetch', dslVisible: true, params: [{ key: 'url', label: 'workflow.param.url', type: 'text', required: true }] },
];

export const httpOutboundHandlers: Record<string, BrandedActionHandler> = {
  'http.outbound.fetch': defineAction(async () => {
    throw new ActionNotImplementedError('http.outbound.fetch');
  }),
};
