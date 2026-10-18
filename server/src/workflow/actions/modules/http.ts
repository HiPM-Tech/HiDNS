import type { NamespaceClaim } from '../../../types/namespace';
import type { ActionDeclaration, BrandedActionHandler } from '../types';
import { httpOutboundActions, httpOutboundHandlers } from '../http/outbound';

export const namespace = {
  owner: 'workflow',
  top: 'http',
  second: ['outbound'],
} as const satisfies NamespaceClaim;

export const declarations: ActionDeclaration[] = [...httpOutboundActions];
export const handlers: Record<string, BrandedActionHandler> = { ...httpOutboundHandlers };
