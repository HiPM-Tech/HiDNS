/**
 * HiDNS 全局主核心 · 动作命名空间白名单
 *
 * 本文件是**唯一定义源**，任何子系统都不得自行新增顶级前缀，只能"认领"。
 * 设计依据：docs/WORKFLOW_ENGINE_DESIGN.md §3.7.4 / D17 / D20
 *
 * 依赖方向：子系统 → 本文件。本文件**不得** import 任何子系统。
 */

/** 已分配的顶级前缀（封闭枚举，新增须走规范变更） */
export const TOP_NAMESPACES = ['dns', 'ext', 'http', 'notify', 'var'] as const;
export type TopNamespace = typeof TOP_NAMESPACES[number];

/** 已登记但未认领：不得出现在任何动作名里 */
export const RESERVED_TOP_NAMESPACES = ['cache', 'queue', 'storage', 'platform'] as const;
export type ReservedTopNamespace = typeof RESERVED_TOP_NAMESPACES[number];

/**
 * 子系统的命名空间认领声明。
 * - top   ：只能取自 TOP_NAMESPACES，且一个顶级前缀只能被一个子系统认领
 * - second：该子系统二次下派的二级前缀白名单
 */
export interface NamespaceClaim {
  /** 认领方标识，用于冲突报错，如 'workflow' */
  readonly owner: string;
  readonly top: TopNamespace;
  readonly second: readonly string[];
}

/** 由 (top, second) 推导出的合法动作名形状 —— 编译期校验用 */
export type ActionNameOf<C extends NamespaceClaim> =
  `${C['top']}.${C['second'][number]}.${string}`;

/**
 * 动作分类：只表达"这类动作为什么要受限"，与动作全名**正交**。
 * 不得从动作名反推分类，不得把厂商名写进分类。
 * 设计依据：D23 / docs/WORKFLOW_ENGINE_DESIGN.md §十五
 */
export const ACTION_CLASSES = [
  'dns.record.read',
  'dns.record.write',
  'ext.read',
  'ext.write',
  'http',
  'notify',
] as const;
export type ActionClass = typeof ACTION_CLASSES[number];

/** 受 §4.0 组合裁决约束的写类动作 */
export const WRITE_ACTION_CLASSES: readonly ActionClass[] = ['dns.record.write', 'ext.write'];

export function isTopNamespace(value: string): value is TopNamespace {
  return (TOP_NAMESPACES as readonly string[]).includes(value);
}

export function isReservedTopNamespace(value: string): value is ReservedTopNamespace {
  return (RESERVED_TOP_NAMESPACES as readonly string[]).includes(value);
}

export function isActionClass(value: string): value is ActionClass {
  return (ACTION_CLASSES as readonly string[]).includes(value);
}
