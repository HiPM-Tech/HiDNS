/**
 * 记录线路输入的语义收敛（唯一归一化点）。
 *
 * 背景：`line` 历史上承担三种含义——线路 ID、Cloudflare/AliyunESA 的代理开关（'0'/'1'）、
 * 以及「未指定」哨兵 '0'。三者混用导致：给阿里云域名带 proxied 会静默改写线路、
 * 华为云等使用真实线路 ID 的提供商会收到非法值 '0'。
 *
 * 规则：
 * - 非代理型提供商：`line` 只表示线路；'0'、''、undefined 一律视为「未指定」→ undefined，
 *   由适配器决定默认线路（例如华为云 default_view）。
 * - 代理型提供商（cloudflare / aliyunesa）：代理开关由 `proxied` 表达；
 *   兼容旧的 `cloudflare.proxied` / `aliyunesa.proxied` 与 `line: '0'|'1'`。
 */

/** 使用「line 兼作代理开关」的提供商 */
export const PROXY_LINE_PROVIDERS: ReadonlySet<string> = new Set(['cloudflare', 'aliyunesa']);

/** 历史哨兵：表示「未指定线路」 */
const UNSPECIFIED_LINE = '0';

export interface LineInput {
  /** 线路 ID */
  line?: string;
  /** 代理开关（新契约） */
  proxied?: boolean;
  /** 旧契约：cloudflare.proxied / aliyunesa.proxied */
  legacyProxied?: boolean;
}

export interface ResolvedLineInput {
  /** 传给适配器的 line；undefined 表示「未指定，由提供商默认」 */
  line?: string;
  /** 代理开关；非代理型提供商恒为 undefined */
  proxied?: boolean;
}

export function resolveLineInput(providerType: string, input: LineInput): ResolvedLineInput {
  const isProxyProvider = PROXY_LINE_PROVIDERS.has(providerType);

  if (!isProxyProvider) {
    return { line: normalizeLineId(input.line) };
  }

  const proxied = input.proxied
    ?? input.legacyProxied
    ?? (input.line === '1' ? true : input.line === '0' ? false : undefined);

  if (proxied === undefined) {
    return { line: normalizeLineId(input.line) };
  }
  return { line: proxied ? '1' : '0', proxied };
}

/** '0' / '' / 纯空白 都视为「未指定」 */
export function normalizeLineId(line?: string): string | undefined {
  if (typeof line !== 'string') return undefined;
  const trimmed = line.trim();
  if (!trimmed || trimmed === UNSPECIFIED_LINE) return undefined;
  return trimmed;
}
