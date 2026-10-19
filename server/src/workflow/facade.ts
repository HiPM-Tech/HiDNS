import type { Dispatcher, DispatchOptions } from './dispatch';
import type { Principal } from './auth';

/**
 * 对外静态 facade：给人类用的写法。
 * 设计依据：§2.3（facade 必须静态，禁止运行时 Proxy）
 *
 * 约束：
 * 1. 每个入口都是显式写下的，不是运行时生成 —— 审计时肉眼可查；
 * 2. 全部经由 dispatch()，与内部文件引用共用同一条 authorize()；
 * 3. 与注册表的一致性由 CI 的 A7 校验，不靠人工同步。
 */

export type FacadeCall = (
  principal: Principal,
  args: Record<string, unknown>,
  options?: DispatchOptions,
) => Promise<unknown>;

export interface WorkflowFacade {
  readonly dns: {
    readonly record: {
      readonly list: FacadeCall;
      readonly get: FacadeCall;
      readonly create: FacadeCall;
      readonly update: FacadeCall;
      readonly delete: FacadeCall;
      readonly setStatus: FacadeCall;
      readonly batch: FacadeCall;
    };
    readonly domain: { readonly list: FacadeCall };
  };
  readonly ext: {
    readonly tencenteo: {
      readonly originGroup: {
        readonly list: FacadeCall;
        readonly get: FacadeCall;
        readonly plan: FacadeCall;
        readonly replace: FacadeCall;
      };
    };
    readonly virtual: {
      readonly originGroup: {
        readonly list: FacadeCall;
        readonly get: FacadeCall;
        readonly planSync: FacadeCall;
        readonly sync: FacadeCall;
      };
    };
  };
  readonly http: { readonly outbound: { readonly fetch: FacadeCall } };
  readonly notify: { readonly channel: { readonly send: FacadeCall } };
  readonly var: { readonly workflow: { readonly get: FacadeCall } };
}

export function createFacade(dispatch: Dispatcher): WorkflowFacade {
  const bind =
    (action: string): FacadeCall =>
    (principal, args, options) =>
      dispatch(action, principal, args, options);

  return {
    dns: {
      record: {
        list: bind('dns.record.list'),
        get: bind('dns.record.get'),
        create: bind('dns.record.create'),
        update: bind('dns.record.update'),
        delete: bind('dns.record.delete'),
        setStatus: bind('dns.record.setStatus'),
        batch: bind('dns.record.batch'),
      },
      domain: { list: bind('dns.domain.list') },
    },
    ext: {
      tencenteo: {
        originGroup: {
          list: bind('ext.tencenteo.originGroup.list'),
          get: bind('ext.tencenteo.originGroup.get'),
          plan: bind('ext.tencenteo.originGroup.plan'),
          replace: bind('ext.tencenteo.originGroup.replace'),
        },
      },
      virtual: {
        originGroup: {
          list: bind('ext.virtual.originGroup.list'),
          get: bind('ext.virtual.originGroup.get'),
          planSync: bind('ext.virtual.originGroup.planSync'),
          sync: bind('ext.virtual.originGroup.sync'),
        },
      },
    },
    http: { outbound: { fetch: bind('http.outbound.fetch') } },
    notify: { channel: { send: bind('notify.channel.send') } },
    var: { workflow: { get: bind('var.workflow.get') } },
  };
}

/** 摊平为动作全名列表，供 CI 做双向一致性校验 */
export function flattenFacadeActions(facade: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(facade)) {
    const action = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'function') out.push(action);
    else if (value && typeof value === 'object') out.push(...flattenFacadeActions(value as Record<string, unknown>, action));
  }
  return out;
}