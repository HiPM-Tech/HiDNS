import type { NamespaceClaim } from '../../../types/namespace';
import type { ActionDeclaration, BrandedActionHandler } from '../types';
import { varWorkflowActions, varWorkflowHandlers } from '../var/workflow';

export const namespace = {
  owner: 'workflow',
  top: 'var',
  second: ['workflow'],
} as const satisfies NamespaceClaim;

export const declarations: ActionDeclaration[] = [...varWorkflowActions];
export const handlers: Record<string, BrandedActionHandler> = { ...varWorkflowHandlers };
