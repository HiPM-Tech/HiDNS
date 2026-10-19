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
    // 注意：ACTION_CLASSES 是封闭的六值枚举（D23 待负责人复核），其中没有「内存读取」一类；
    // 该动作不发起任何网络请求，归入 http 仅为占位，实际用途已由 DSL 的 vars.x 引用覆盖。
    actionClass: 'http',
    risk: 'low',
    service: 'system.read',
    // 不再对声明式定义开放：ref 已能读取运行期变量，暴露成动作只是多余攻击面
    dslVisible: false,
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