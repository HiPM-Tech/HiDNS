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
  /** i18n key：参数的补充说明（渲染在控件下方），用于解释「这个值从哪来」 */
  hint?: string;
  /**
   * 声明式前端校验（设计 §788：服务端拒绝的内网源站，前端应提前提示）。
   * `public-origin` = 该值不能是内网/回环/本地主机。服务端仍是权威判定。
   */
  validation?: 'public-origin';
  options?: string[];
  /**
   * 候选来源（`/api/workflows/meta/:source`）。
   * 声明后前端渲染为下拉，并通过 `sourceParams` 传参拉取候选。
   */
  source?: string;
  /** 静态查询参数：随候选请求一起发送（如 accounts?originGroup=true） */
  sourceQuery?: Record<string, string>;
  /** 允许直接填写（候选列不出来时仍可继续），前端渲染为 AutoComplete */
  allowFreeInput?: boolean;
  /**
   * 联想来源（设计 §3.1 的 `[...]` 形态）：可自由输入，同时给出候选建议。
   * 与 `source` 的区别是 `source` 只能从候选里选，这里允许填候选之外的值。
   */
  suggestSource?: string;
  /** 拉取候选时需要一并带上的其它参数（取同一条动作的实参值） */
  sourceParams?: string[];
}

export interface ActionDeclaration {
  /** 动作全名：<top>.<second>.<verb> */
  name: string;
  /** i18n key */
  label: string;
  /** i18n key：一句话说明这个动作到底做什么（编辑器直接展示，避免用户靠猜） */
  description?: string;
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
