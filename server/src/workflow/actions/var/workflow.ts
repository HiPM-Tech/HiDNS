import type { ActionDeclaration, BrandedActionHandler } from '../types';
import { defineAction, ActionNotImplementedError } from '../types';

export const varWorkflowActions: ActionDeclaration[] = [
  { name: 'var.workflow.get', label: 'workflow.action.var_workflow_get', actionClass: 'http', risk: 'low', service: 'system.read', dslVisible: true, params: [{ key: 'key', label: 'workflow.param.key', type: 'text', required: true }] },
];

export const varWorkflowHandlers: Record<string, BrandedActionHandler> = {
  'var.workflow.get': defineAction(async () => {
    throw new ActionNotImplementedError('var.workflow.get');
  }),
};
