/**
 * 跨提供商凭据复用声明（**双向**）。
 *
 * 背景：EdgeOne 与 DNSPod 共用腾讯云统一鉴权，因此 EdgeOne 源站组可以直接拿
 * DNSPod 账号的 SecretId / SecretKey 发请求。但这个能力不能由**消费方单方面**决定：
 * 如果消费方自己写一句"我可以复用 dnspod 的凭据"，那么任何提供商（包括第三方注入的）
 * 都能照做，等于把所有提供商的密钥都暴露给任何一个提供商实现。
 *
 * 因此要求两端各自声明，且必须互相命中才放行：
 *   - 导出方声明「我允许谁复用我的凭据」→ CREDENTIAL_EXPORTS
 *   - 消费方声明「我要复用谁的凭据」    → CREDENTIAL_IMPORTS
 *   - 判定 = 导出方名单包含消费方 && 消费方名单包含导出方
 *
 * 只有一边声明 = 不放行。这样注入一个恶意提供商，必须同时改到**别人的**声明文件，
 * 单点注入无法生效。
 *
 * 本文件是叶子模块（不 import 任何其它模块），供提供商实现直接引用，
 * 避免 providers → registry 的循环依赖。
 */

/** 导出方 → 允许复用其凭据的消费方 */
export const CREDENTIAL_EXPORTS: Readonly<Record<string, readonly string[]>> = {
  dnspod: ['tencenteo'],
};

/** 消费方 → 它要复用的导出方 */
export const CREDENTIAL_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  tencenteo: ['dnspod'],
};

/**
 * 纯函数判定，便于用构造的表证明"单边声明不放行"。
 */
export function evaluateCredentialSharing(
  imports: Readonly<Record<string, readonly string[]>>,
  exports: Readonly<Record<string, readonly string[]>>,
  consumerType: string,
  sourceType: string,
): boolean {
  const imported = imports[consumerType] ?? [];
  const exported = exports[sourceType] ?? [];
  return imported.includes(sourceType) && exported.includes(consumerType);
}

/** 消费方能否复用导出方的凭据（双向声明都命中才算） */
export function mayReuseCredentials(consumerType: string, sourceType: string): boolean {
  return evaluateCredentialSharing(CREDENTIAL_IMPORTS, CREDENTIAL_EXPORTS, consumerType, sourceType);
}

/** 供注册表校验：所有被引用的提供商类型都必须真实存在 */
export function listSharingParticipants(): { importers: string[]; sources: string[] } {
  const importers = new Set(Object.keys(CREDENTIAL_IMPORTS));
  const sources = new Set(Object.keys(CREDENTIAL_EXPORTS));
  for (const targets of Object.values(CREDENTIAL_IMPORTS)) for (const t of targets) sources.add(t);
  for (const targets of Object.values(CREDENTIAL_EXPORTS)) for (const t of targets) importers.add(t);
  return { importers: [...importers], sources: [...sources] };
}

/**
 * 自检：任一方声明了对方未声明的复用关系，即为配置错误。
 * 返回问题描述列表，空数组表示一致。
 */
export function findSharingInconsistencies(): string[] {
  const problems: string[] = [];
  for (const [consumer, sources] of Object.entries(CREDENTIAL_IMPORTS)) {
    for (const source of sources) {
      if (!(CREDENTIAL_EXPORTS[source] ?? []).includes(consumer)) {
        problems.push(`${consumer} 声明复用 ${source} 的凭据，但 ${source} 未声明允许 ${consumer} 复用`);
      }
    }
  }
  for (const [source, consumers] of Object.entries(CREDENTIAL_EXPORTS)) {
    for (const consumer of consumers) {
      if (!(CREDENTIAL_IMPORTS[consumer] ?? []).includes(source)) {
        problems.push(`${source} 声明允许 ${consumer} 复用，但 ${consumer} 未声明要复用 ${source}`);
      }
    }
  }
  return problems;
}
