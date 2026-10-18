import type { NamespaceClaim } from '../../../types/namespace';
import type { ActionDeclaration, BrandedActionHandler } from '../types';
import { notifyChannelActions, notifyChannelHandlers } from '../notify/channel';

export const namespace = {
  owner: 'workflow',
  top: 'notify',
  second: ['channel'],
} as const satisfies NamespaceClaim;

export const declarations: ActionDeclaration[] = [...notifyChannelActions];
export const handlers: Record<string, BrandedActionHandler> = { ...notifyChannelHandlers };
