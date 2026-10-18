import type { ActionDeclaration, BrandedActionHandler } from '../types';
import { defineAction } from '../types';

/**
 * 工作流局部变量读取。仅能读到本次运行注入的变量快照，
 * 无法触及用户、鉴权或数据库。设计依据：§5.6 数据暴露面。
 */
export const varWorkflowActions: ActionDeclaration[] = [
  {
    name: 'var.workflow.get',
    label: 'workflow.action.var_workflow_get',
    actionClass: 'http',
    risk: 'low',
    service: 'system.read',
    dslVisible: true,
    params: [{ key: 'key', label: 'workflow.param.key', type: 'text', required: true }],
  },
];

export const varWorkflowHandlers: Record<string, BrandedActionHandler> = {
  'var.workflow.get': defineAction(async (ctx, args) => {
    const key = String(args.key ?? '');
    const vars = ctx.vars ?? {};
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : null;
  }),
};