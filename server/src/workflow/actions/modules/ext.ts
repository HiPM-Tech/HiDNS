import type { NamespaceClaim } from '../../../types/namespace';
import type { ActionDeclaration, BrandedActionHandler } from '../types';
import { defineAction } from '../types';
import { AuthorizationError } from '../../auth';
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
/**
 * 扩展能力的 handler 由各提供商自行注册。
 *
 * 这里必须做**域名级二次校验**：`authorize` 校验的是事件域名，
 * 而扩展动作的目标域名来自 `args.domainId` —— 不校验就等于允许跨租户读写。
 */
function wrap(
  handler: (args: Record<string, unknown>) => Promise<unknown>,
  actionClass: string,
): BrandedActionHandler {
  const writeClass = actionClass === 'ext.write';
  return defineAction(async (ctx, args) => {
    const domainId = Number(args.domainId);
    const ids = writeClass ? ctx.principal.allowedWriteDomainIds : ctx.principal.allowedDomainIds;

    // 写类动作没有可写集合时 fail-closed；读类缺集合时同样拒绝（不再 fail-open）
    if (!ids) {
      throw new AuthorizationError(403, writeClass ? '写类动作缺少可写域名集合' : '缺少可访问域名集合');
    }
    if (!Number.isFinite(domainId) || domainId <= 0) {
      throw new AuthorizationError(400, '扩展动作必须提供有效的 domainId');
    }
    if (!ids.includes(domainId)) {
      throw new AuthorizationError(403, `域名权限不足: #${domainId}`);
    }
    return handler(args);
  });
}

export const handlers: Record<string, BrandedActionHandler> = Object.assign(
  {},
  ...providerDefinitions.flatMap((definition) =>
    (definition.extraCapabilities ?? []).map((capability) =>
      Object.fromEntries(
        Object.entries(capability.handlers ?? {}).map(([name, handler]) => {
          const declaration = capability.actions.find((action) => action.name === name);
          return [name, wrap(handler, declaration?.actionClass ?? 'ext.read')];
        }),
      ),
    ),
  ),
);
