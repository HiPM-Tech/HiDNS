/**
 * 虚拟提供商可用性判定。
 *
 * 定位：**开发工具，不是产品能力**。它让开发者在不持有真实凭证的情况下演练工作流，
 * 但不应以任何形式出现在生产环境——既不显示在提供商列表里，也不可被调用。
 *
 * 判定顺序（失败关闭）：
 *   1. NODE_ENV=production → 关闭。这是硬关闭：即使误配了开关也不会打开
 *   2. 必须显式设置 HIDNS_ENABLE_VIRTUAL_PROVIDER=1/true/yes/on → 打开
 *   3. 其余情况一律关闭
 *
 * 为什么不用"生产就关闭"作为唯一判据：进程可能根本没设 NODE_ENV，
 * 那种情况下按生产处理会变成"忘设就默认打开"。所以要求显式开启。
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function isVirtualProviderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (String(env.NODE_ENV ?? '').toLowerCase() === 'production') return false;
  return TRUTHY.has(String(env.HIDNS_ENABLE_VIRTUAL_PROVIDER ?? '').toLowerCase());
}

/** 供 UI/日志展示的关闭原因 */
export function virtualProviderDisabledReason(env: NodeJS.ProcessEnv = process.env): string {
  if (String(env.NODE_ENV ?? '').toLowerCase() === 'production') {
    return '虚拟提供商仅用于开发环境，生产环境不可用';
  }
  return '虚拟提供商未启用：需设置 HIDNS_ENABLE_VIRTUAL_PROVIDER=1';
}
