import type { DnsAdapter } from '../DnsInterface';

/**
 * 提供商侧候选值（如源站组）。
 *
 * 核心路由只按 source 名转发，不解释语义、不 import 具体提供商 ——
 * 依据 root.ai.md §306-311：扩展能力的语义留在提供商目录内。
 */
export interface ProviderMetaContext {
  domainId: number;
  domainName: string;
  /** 上游作用域标识（核心只透传 domains.third_id，不解释其含义） */
  zoneId: string;
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

export interface ProviderMetaSource {
  source: string;
  providerType: string;
  resolve(ctx: ProviderMetaContext): Promise<ProviderMetaItem[]>;
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