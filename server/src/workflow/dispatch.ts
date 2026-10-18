import { authorize, AuthorizationError, type AuthorizeDeps, type AuthorizeOptions, type Principal, type ResourceRef } from './auth';
import type { ActionMeta } from './auth';
import type { BrandedActionHandler } from './actions/types';
import { lookupActionMeta, lookupHandler } from './actions/registry';

/**
 * 动作派发：唯一执行入口。
 * 设计依据：§2.3 双通道、§5.0 统一鉴权闸门
 *
 * 顺序固定：**先鉴权，再取 handler**。
 * 反过来的话，未授权调用也能探测到"动作是否存在"。
 */

export interface DispatchDeps {
  readonly authorizeDeps: AuthorizeDeps;
  lookupMeta?(name: string): ActionMeta | null;
  lookupHandler?(name: string): BrandedActionHandler | null;
}

export interface DispatchOptions extends AuthorizeOptions {
  readonly resource?: ResourceRef;
}

export type Dispatcher = (
  action: string,
  principal: Principal,
  args: Record<string, unknown>,
  options?: DispatchOptions,
) => Promise<unknown>;

export function createDispatcher(deps: DispatchDeps): Dispatcher {
  const lookupMeta = deps.lookupMeta ?? lookupActionMeta;
  const getHandler = deps.lookupHandler ?? lookupHandler;

  return async function dispatch(action, principal, args, options = {}) {
    const ctx = await authorize(action, principal, options.resource, deps.authorizeDeps, options);
    const handler = getHandler(ctx.action);
    if (!handler) {
      // 已通过鉴权却找不到实现：注册表与实现漂移，属于部署缺陷
      throw new AuthorizationError(500, `动作已注册但缺少实现: ${ctx.action}`);
    }
    return handler(ctx, args);
  };
}