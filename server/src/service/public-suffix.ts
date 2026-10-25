import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../lib/logger';
import { PublicSuffixOperations } from '../db/bal/public-suffix-operations';
import { APEX_PROVIDERS, SUBDOMAIN_PROVIDERS, THIRD_PARTY_PROVIDERS } from './whois/registry';
import { isUnicodeDomain, toPunycode } from '../utils/domain';

const log = createLogger('SUFFIX');

/**
 * 公共后缀（public suffix）运行时来源。
 *
 * 真值在 DB 表 `public_suffixes`（由 PUB_SUFFIX_JOB 定期从上游下拉），
 * 这里只维护一份内存 Set 供 `getRootDomain` 同步查询；内置清单用于**首次播种**与
 * 「表为空/上游不可达」时的兜底，不覆盖用户已入库的数据。
 */

/** 内置种子：常见二级后缀 + WHOIS 注册表声明的 suffix（dpdns.org / us.kg / cc.cd …） */
export const BUILTIN_SUFFIXES: readonly string[] = [
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'mil.cn',
  'co.uk', 'org.uk', 'net.uk', 'gov.uk', 'ac.uk', 'me.uk',
  'com.au', 'net.au', 'org.au', 'gov.au', 'edu.au',
  'co.jp', 'ne.jp', 'or.jp', 'go.jp', 'ac.jp',
  'com.sg', 'net.sg', 'org.sg', 'gov.sg', 'edu.sg',
  'com.hk', 'net.hk', 'org.hk', 'gov.hk', 'edu.hk',
  'com.tw', 'net.tw', 'org.tw', 'gov.tw', 'edu.tw',
  'co.kr', 'ne.kr', 'or.kr', 'go.kr', 'ac.kr',
  'com.br', 'com.mx', 'co.nz', 'co.za', 'co.il', 'co.th',
  'cc.cd', 'dpdns.org', 'us.kg', 'xx.kg', 'qzz.io', 'qd.je',
  ...APEX_PROVIDERS.flatMap((provider) => provider.suffixes ?? []),
  ...SUBDOMAIN_PROVIDERS.flatMap((provider) => provider.suffixes ?? []),
  ...THIRD_PARTY_PROVIDERS.flatMap((provider) => provider.suffixes ?? []),
];

/**
 * 内嵌快照：server/src/data/public-suffix-list.dat（publicsuffix.org 的 DAT，含 ICANN + PRIVATE 两段）。
 * 为什么内嵌：全新实例/内网环境首次启动时既没有 DB 数据也未必能联网，
 * 没有快照就只能退化成「取最后两段」，分组会把 cc.cd / dpdns.org 这类多段后缀切碎。
 */
function loadEmbeddedSuffixes(): string[] {
  try {
    const file = path.resolve(__dirname, '../data/public-suffix-list.dat');
    return parsePublicSuffixList(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    log.warn('Embedded public suffix snapshot missing, falling back to curated list', { error });
    return [];
  }
}

const EMBEDDED_SUFFIXES = loadEmbeddedSuffixes();

const inMemory = new Set<string>(
  [...BUILTIN_SUFFIXES, ...EMBEDDED_SUFFIXES].map((suffix) => suffix.toLowerCase()),
);

/** 当前生效的后缀集合（只读快照，供 getRootDomain 同步使用） */
export function getPublicSuffixSet(): ReadonlySet<string> {
  return inMemory;
}

/**
 * 判断候选串是否是公共后缀。
 * 支持 PSL 的通配写法 `*.ck`：`x.ck` 命中时说明 `x.ck` 本身是公共后缀。
 */
export function isPublicSuffix(candidate: string): boolean {
  const normalized = candidate.toLowerCase();
  if (inMemory.has(normalized)) return true;
  const dot = normalized.indexOf('.');
  if (dot < 0) return false;
  return inMemory.has('*.' + normalized.slice(dot + 1));
}

/**
 * 解析 PSL 文本（publicsuffix.org 的 DAT 格式）。
 *
 * - 忽略空行与 `//` 注释；
 * - 忽略 ICANN/PRIVATE 分段标记（都是注释）；
 * - `!` 是例外规则（表示"不是公共后缀"），这里**跳过**——保留它会让判定更严格，
 *   而我们的用途是"尽量别把可注册域切碎"，跳过是更安全的一侧；
 * - `*.` 通配保留原样，交给 isPublicSuffix 处理。
 */
export function parsePublicSuffixList(text: string): string[] {
  const out = new Set<string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('!')) continue;
    let value = line.toLowerCase();
    if (!/^[\p{L}\p{N}.*\-]+$/u.test(value)) continue;
    if (isUnicodeDomain(value)) value = toPunycode(value);
    if (!value.includes('.') && !/^xn--/.test(value)) {
      // 单段 TLD 也允许（com / cn / xn--fiqs8s）
    }
    if (!/^[a-z0-9.*\-]+$/.test(value)) continue;
    out.add(value);
  }
  return [...out];
}

/** 从 DB 载入内存集合；表为空时用内置清单播种（幂等） */
export async function loadPublicSuffixesFromDb(): Promise<number> {
  try {
    let rows = await PublicSuffixOperations.getAll();
    if (rows.length === 0) {
      const inserted = await PublicSuffixOperations.seed([...BUILTIN_SUFFIXES, ...EMBEDDED_SUFFIXES]);
      log.info('Seeded public suffix table from builtin list', { inserted });
      rows = await PublicSuffixOperations.getAll();
    }
    inMemory.clear();
    for (const row of rows) inMemory.add(row.suffix.toLowerCase());
    for (const suffix of BUILTIN_SUFFIXES) inMemory.add(suffix.toLowerCase());
    log.info('Public suffixes loaded', { count: rows.length, effective: inMemory.size });
    return rows.length;
  } catch (error) {
    // DB 尚未就绪时不要影响启动：继续用内置清单
    log.warn('Failed to load public suffixes from DB, using builtin list', { error });
    return 0;
  }
}

/**
 * 从上游下拉并入库。
 * URL 由 `PUBLIC_SUFFIX_LIST_URL` 指定（默认 publicsuffix.org 的 DAT）；
 * 下载失败不动库里现有数据，只记日志——域名分组不能因为一次网络抖动而崩。
 */
export async function refreshPublicSuffixes(url?: string): Promise<{ updated: number } | null> {
  const source = url ?? process.env.PUBLIC_SUFFIX_LIST_URL ?? 'https://publicsuffix.org/list/public_suffix_list.dat';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const response = await fetch(source, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      log.warn('Public suffix list download failed', { status: response.status, source });
      return null;
    }
    const text = await response.text();
    const parsed = parsePublicSuffixList(text);
    if (parsed.length < 100) {
      // 明显不正常的响应（HTML 错误页等）不入库
      log.warn('Public suffix list looks invalid, skipped', { parsed: parsed.length, source });
      return null;
    }
    const updated = await PublicSuffixOperations.replaceSource('iana', parsed);
    await loadPublicSuffixesFromDb();
    log.info('Public suffix list updated', { updated, source });
    return { updated };
  } catch (error) {
    log.warn('Public suffix refresh failed', { error, source });
    return null;
  }
}

/** 仅测试用：替换内存集合 */
export function __setPublicSuffixesForTests(list: string[]): void {
  inMemory.clear();
  for (const suffix of list) inMemory.add(suffix.toLowerCase());
}
