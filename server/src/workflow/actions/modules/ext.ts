import type { NamespaceClaim } from '../../../types/namespace';
import type { ActionDeclaration, BrandedActionHandler } from '../types';
import { providerDefinitions, PROVIDER_TYPES } from '../../../lib/dns/providers/registry';

/**
 * 工作流认领 ext 顶级前缀。
 * 二级前缀**动态**取自 registry 的 providerType，新增提供商时自动跟随。
 */
export const namespace = {
  owner: 'workflow',
  top: 'ext',
  second: PROVIDER_TYPES,
} as const satisfies NamespaceClaim;

/** 从各提供商的 extraCapabilities 反向收集动作声明 */
export const declarations: ActionDeclaration[] = providerDefinitions.flatMap((definition) =>
  (definition.extraCapabilities ?? []).flatMap((capability) =>
    capability.actions.map((action) => ({
      name: action.name,
      label: action.label,
      actionClass: action.actionClass,
      risk: action.risk,
      service: action.service,
      dslVisible: action.dslVisible,
      params: action.params,
    })),
  ),
);

/**
 * 扩展能力的 handler 由各提供商自行注册（P2 接入）。
 * 未注册的扩展动作会在 CI 的 A8 检查中暴露，不会静默通过。
 */
export const handlers: Record<string, BrandedActionHandler> = {};
