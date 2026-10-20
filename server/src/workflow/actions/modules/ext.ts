import type { ActionClass, NamespaceClaim } from '../../../types/namespace';
import type { ProviderAuthorize } from '../../../lib/dns/providers/extra-types';
import type { ActionDeclaration, BrandedActionHandler } from '../types';
import { defineAction } from '../types';
import { assertExtDomainAllowed } from '../ext-guard';
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
 * 这里必须做**资源级二次校验**：`authorize` 校验的是事件域名，
 * 而扩展动作的目标资源来自 `args` —— 不校验就等于允许跨租户操作。
 *
 * 缺省按 `args.domainId` 做域名级校验；能力声明了 `authorize` 钩子时以钩子为准
 * （例如 EdgeOne 源站组属于"站点"而不是域名，用域名写权限约束它既不对等也会误伤）。
 */
function wrap(
  handler: (args: Record<string, unknown>) => Promise<unknown>,
  actionClass: string,
  authorize?: ProviderAuthorize,
): BrandedActionHandler {
  return defineAction(async (ctx, args) => {
    if (authorize) {
      await authorize(ctx.principal, args, actionClass as ActionClass);
    } else {
      assertExtDomainAllowed(ctx.principal, args.domainId, actionClass);
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
          // 缺声明时按读集合兜底等于 fail-open —— 直接拒绝注册
          if (!declaration) throw new Error(`扩展动作缺少声明: ${name}`);
          return [name, wrap(handler, declaration.actionClass, capability.authorize)];
        }),
      ),
    ),
  ),
);
