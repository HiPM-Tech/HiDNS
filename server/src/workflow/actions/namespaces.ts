import type { NamespaceClaim } from '../../types/namespace';
import * as dnsModule from './modules/dns';
import * as extModule from './modules/ext';
import * as httpModule from './modules/http';
import * as notifyModule from './modules/notify';
import * as varModule from './modules/var';

/**
 * 工作流子系统认领的命名空间。
 * 注意：**白名单不在这里**，它在全局主核心 server/src/types/namespace.ts。
 * 工作流只是认领方之一。设计依据：D17 / D20
 */
export const workflowNamespaceClaims: readonly NamespaceClaim[] = [
  dnsModule.namespace,
  extModule.namespace,
  httpModule.namespace,
  notifyModule.namespace,
  varModule.namespace,
] as readonly NamespaceClaim[];
