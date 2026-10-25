import type { RequestHandler, Router } from 'express';

/**
 * 一个可挂载的 API 模块。
 *
 * 设计约束（微架构）：
 * 1. 模块只描述「自己是谁、挂在哪、要不要过初始化门禁」，不关心其它模块；
 * 2. 挂载顺序、门禁、文档由 api 层统一处理，模块不得自行 app.use；
 * 3. 初始化豁免必须显式声明（默认拒绝），禁止在门禁里维护第二份前缀清单。
 */
export interface ApiModule {
  /** 模块唯一标识，用于清单、日志与重复校验 */
  readonly id: string;
  /** 挂载前缀：必须以 /api 开头，不带结尾斜杠 */
  readonly prefix: string;
  /** 业务路由 */
  readonly router: Router;
  /** 挂载前依次执行的中间件（限流等） */
  readonly middlewares?: readonly RequestHandler[];
  /** 未初始化时是否放行；默认 false（受初始化门禁保护） */
  readonly exemptFromInitGate?: boolean;
  /**
   * 数据库不可达（初始化面已关闭）时仍允许访问的只读探测路径。
   * 仅允许「不改变状态」的端点，写操作必须一并关闭。
   */
  readonly closedStateProbes?: readonly string[];
  /** 一行说明，用于清单与 API 文档生成 */
  readonly description: string;
}

/** 供文档生成 / 诊断使用的模块清单条目 */
export interface ApiManifestEntry {
  readonly id: string;
  readonly prefix: string;
  readonly exemptFromInitGate: boolean;
  readonly closedStateProbes: readonly string[];
  readonly middlewareCount: number;
  readonly description: string;
}
