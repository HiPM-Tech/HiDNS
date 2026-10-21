import type { DnsAdapter } from '../DnsInterface';

/**
 * 提供商侧候选值（如源站组）。
 *
 * 核心路由只按 source 名转发，不解释语义、不 import 具体提供商 ——
 * 依据 root.ai.md §306-311：扩展能力的语义留在提供商目录内。
 */
export interface ProviderMetaContext {
  /**
   * 域名模式的入参（历史形态）。账号模式的源不会带它。
   * 设计 §3.7.8 要求源站组按「账号 + 作用域」定位，因此这两个字段改为可选。
   */
  domainId?: number;
  domainName?: string;
  /** 上游作用域标识（核心只透传 domains.third_id，不解释其含义） */
  zoneId?: string;
  /** 账号模式的入参：定位到「哪个账号」——候选源与执行路径用同一套鉴权 */
  accountId?: number;
  /** 账号模式的作用域（tencenteo 下即 ZoneId），需经归属校验后才可使用 */
  scopeId?: string;
  adapter: DnsAdapter;
  /**
   * 前端声明的其它参数（来自参数声明里的 sourceParams）。
   * 核心只透传，不解释语义 —— 例如腾讯云源站组需要的 siteType。
   */
  params: Readonly<Record<string, string>>;
}

export interface ProviderMetaItem {
  value: string;
  label: string;
  [extra: string]: unknown;
}

/**
 * 候选源的定位维度。
 *
 * - `domain`（默认）：入参是 `domainId`，路由按域名归属校验并取该域名的账号凭据；
 * - `account`：入参是 `accountId`（+可选 `scopeId`），路由按**账号**归属校验。
 *
 * 路由必须按此分流：两者的入参、归属校验、取适配器的方式都不同，
 * 混用会让「域名 id」与「账号 id」互相冒充（两张表主键都是小整数）。
 */
export type ProviderMetaScope = 'domain' | 'account';

export interface ProviderMetaSource {
  source: string;
  providerType: string;
  /** 缺省按 `domain` 处理，保持既有源的行为不变 */
  scope?: ProviderMetaScope;
  resolve(ctx: ProviderMetaContext): Promise<ProviderMetaItem[]>;
}

/**
 * 域名模式的源取 domainId。缺失说明路由按错误的维度分流了——
 * 宁可报错，也不要拿 undefined 去查库（会变成全表第一条）。
 */
export function requireDomainId(ctx: ProviderMetaContext): number {
  if (typeof ctx.domainId !== 'number' || !Number.isFinite(ctx.domainId)) {
    throw new Error('候选源需要 domainId：该源声明为 domain 维度，但路由未提供域名');
  }
  return ctx.domainId;
}

/** 账号模式的源取 accountId；同样不允许用 undefined 兜底 */
export function requireAccountId(ctx: ProviderMetaContext): number {
  if (typeof ctx.accountId !== 'number' || !Number.isFinite(ctx.accountId)) {
    throw new Error('候选源需要 accountId：该源声明为 account 维度，但路由未提供账号');
  }
  return ctx.accountId;
}

const registry = new Map<string, ProviderMetaSource>();

export function registerProviderMetaSource(source: ProviderMetaSource): void {
  registry.set(source.source, source);
}

export function getProviderMetaSource(name: string): ProviderMetaSource | undefined {
  return registry.get(name);
}

export function listProviderMetaSources(): string[] {
  return [...registry.keys()];
}