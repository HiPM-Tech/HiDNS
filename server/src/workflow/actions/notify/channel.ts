import type { ActionDeclaration, BrandedActionHandler } from '../types';
import { defineAction } from '../types';
import { AuthorizationError } from '../../auth';
import { sendNotification } from '../../../service/notification';

/**
 * 通知动作。底层复用既有 notification 服务（发送到已配置的全部渠道），
 * 因此 v1 **不支持指定单一渠道** —— 选择器留待 P3 与服务改造一并处理。
 */
export const notifyChannelActions: ActionDeclaration[] = [
  {
    name: 'notify.channel.send',
    label: 'workflow.action.notify_channel_send',
    actionClass: 'notify',
    risk: 'low',
    service: 'notify.send',
    dslVisible: true,
    params: [
      { key: 'title', label: 'workflow.param.title', type: 'text', required: false },
      { key: 'message', label: 'workflow.param.message', type: 'text', required: true },
    ],
  },
];

export const notifyChannelHandlers: Record<string, BrandedActionHandler> = {
  'notify.channel.send': defineAction(async (_ctx, args) => {
    const message = typeof args.message === 'string' ? args.message.trim() : '';
    if (!message) throw new AuthorizationError(400, '缺少 message');
    const title = typeof args.title === 'string' && args.title ? args.title : 'HiDNS 工作流通知';
    await sendNotification(title, message);
    return { sent: true };
  }),
};