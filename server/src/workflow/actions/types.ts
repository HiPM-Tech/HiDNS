import type { ActionClass } from '../../types/namespace';
import type { AvailableService } from '../../types/token';
import type { ActionContext } from '../auth';

/**
 * 动作声明与实现的唯一契约。
 * 设计依据：docs/WORKFLOW_ENGINE_DESIGN.md §2.3 / §3.7.4
 */

export interface ActionParam {
  key: string;
  /** i18n key */
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  required: boolean;
  options?: string[];
}

export interface ActionDeclaration {
  /** 动作全名：<top>.<second>.<verb> */
  name: string;
  /** i18n key */
  label: string;
  actionClass: ActionClass;
  risk: 'low' | 'medium' | 'high';
  service: AvailableService;
  /** 是否对声明式 DSL 可见 */
  dslVisible: boolean;
  params: ActionParam[];
}

export type ActionHandler = (ctx: ActionContext, args: Record<string, unknown>) => Promise<unknown>;

declare const ACTION_BRAND: unique symbol;

/** 带品牌的 handler：只有 defineAction() 能产出 */
export type BrandedActionHandler = ActionHandler & { readonly [ACTION_BRAND]: true };

const ACTION_MARK = '__workflowAction';

/**
 * 所有 handler 的唯一构造入口。
 * 手写裸函数无法满足 BrandedActionHandler，registry 只接受品牌类型。
 */
export function defineAction(handler: ActionHandler): BrandedActionHandler {
  Object.defineProperty(handler, ACTION_MARK, { value: true, enumerable: false });
  return handler as BrandedActionHandler;
}

export function isBrandedAction(value: unknown): value is BrandedActionHandler {
  return typeof value === 'function' && (value as unknown as Record<string, unknown>)[ACTION_MARK] === true;
}

export class ActionNotImplementedError extends Error {
  constructor(action: string) {
    super(`动作尚未实现: ${action}`);
    this.name = 'ActionNotImplementedError';
  }
}
