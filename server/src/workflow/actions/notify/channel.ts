import type { ActionDeclaration, BrandedActionHandler } from '../types';
import { defineAction, ActionNotImplementedError } from '../types';

export const notifyChannelActions: ActionDeclaration[] = [
  { name: 'notify.channel.send', label: 'workflow.action.notify_channel_send', actionClass: 'notify', risk: 'low', service: 'notify.send', dslVisible: true, params: [{ key: 'channel', label: 'workflow.param.channel', type: 'text', required: true }] },
];

export const notifyChannelHandlers: Record<string, BrandedActionHandler> = {
  'notify.channel.send': defineAction(async () => {
    throw new ActionNotImplementedError('notify.channel.send');
  }),
};
