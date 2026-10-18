import type { ActionDeclaration, BrandedActionHandler } from './types';
import type { ActionMeta } from '../auth';
import * as dnsModule from './modules/dns';
import * as extModule from './modules/ext';
import * as httpModule from './modules/http';
import * as notifyModule from './modules/notify';
import * as varModule from './modules/var';

/**
 * 动作注册表：声明与实现**双向注册**的唯一出口。
 * 设计依据：docs/WORKFLOW_ENGINE_DESIGN.md §2.3 / §3.7.4
 *
 * - ALL_ACTIONS：声明（人类可读，带参数/权限/风险）
 * - HANDLERS   ：实现（按全名分派）
 * 二者必须双向一致，由 CI 的 A5 / A8 强制。
 */

export interface ActionModule {
  namespace: { readonly owner: string; readonly top: string; readonly second: readonly string[] };
  declarations: ActionDeclaration[];
  handlers: Record<string, BrandedActionHandler>;
}

export const MODULES: readonly ActionModule[] = [
  dnsModule,
  extModule,
  httpModule,
  notifyModule,
  varModule,
];

export const ALL_ACTIONS: readonly ActionDeclaration[] = MODULES.flatMap((m) => m.declarations);

export const HANDLERS: Readonly<Record<string, BrandedActionHandler>> = Object.assign(
  {},
  ...MODULES.map((m) => m.handlers),
);

const ACTION_INDEX = new Map<string, ActionDeclaration>(ALL_ACTIONS.map((a) => [a.name, a]));

/** 精确查找：禁止前缀 / 通配 / 大小写变体 */
export function lookupActionDeclaration(name: string): ActionDeclaration | null {
  return ACTION_INDEX.get(name) ?? null;
}

export function lookupActionMeta(name: string): ActionMeta | null {
  const declaration = ACTION_INDEX.get(name);
  if (!declaration) return null;
  return {
    name: declaration.name,
    actionClass: declaration.actionClass,
    service: declaration.service,
    dslVisible: declaration.dslVisible,
  };
}

export function lookupHandler(name: string): BrandedActionHandler | null {
  return HANDLERS[name] ?? null;
}
