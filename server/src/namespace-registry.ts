import type { NamespaceClaim } from './types/namespace';
import { workflowNamespaceClaims } from './workflow/actions/namespaces';

/**
 * 组合根：汇总各子系统的命名空间认领。
 * 设计依据：docs/WORKFLOW_ENGINE_DESIGN.md §3.7.4 / D20
 *
 * 依赖方向：本文件允许依赖各子系统；全局主核心 types/namespace.ts 不依赖任何子系统。
 * 将来新增子系统时在此追加（如 mcpNamespaceClaims）。
 */
export const ALL_NAMESPACE_CLAIMS: readonly NamespaceClaim[] = [...workflowNamespaceClaims];
