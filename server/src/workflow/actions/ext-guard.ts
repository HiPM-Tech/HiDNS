import { AuthorizationError, type ActionContext } from '../auth';

/**
 * 扩展动作的域名级二次校验。
 *
 * `authorize` 校验的是**事件域名**，而扩展动作的目标域名来自 `args.domainId`；
 * 不在这里校验就等于允许跨租户读写他人域名的源站组。
 *
 * 独立成模块的原因：`modules/ext.ts` 依赖提供商注册表，
 * 直接 import 会把循环依赖带进单测；这里只依赖 auth。
 */
export function assertExtDomainAllowed(
  principal: ActionContext['principal'],
  domainId: unknown,
  actionClass: string,
): number {
  // 与 origin-group-authorize 同口径：只有显式 ext.read 算读，其余按写（失败关闭）。
  const writeClass = actionClass !== 'ext.read';
  const ids = writeClass ? principal.allowedWriteDomainIds : principal.allowedDomainIds;

  // fail-closed：没有集合就拒绝，不再因 undefined 放行
  if (!ids) {
    throw new AuthorizationError(403, writeClass ? '写类动作缺少可写域名集合' : '缺少可访问域名集合');
  }

  const id = Number(domainId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new AuthorizationError(400, '扩展动作必须提供有效的 domainId');
  }
  if (!ids.includes(id)) {
    throw new AuthorizationError(403, `域名权限不足: #${id}`);
  }
  return id;
}