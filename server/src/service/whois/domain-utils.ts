/**
 * 域名工具函数
 * 支持国际化域名(IDN)，包括中文域名
 */

import { normalizeDomain } from '../../utils/dns';
import { getPublicSuffixSet, isPublicSuffix } from '../public-suffix';

/**
 * 命中的最长公共后缀（找不到时返回最后一段）。
 *
 * 后缀集合来自 DB（`public_suffixes`，定时从上游下拉），`getPublicSuffixSet` 只给内存快照；
 * 因此这里保持同步签名，不能在解析路径里 await。
 */
export function getPublicSuffix(domainName: string): string {
  const normalized = normalizeDomain(domainName);
  const parts = normalized.split('.');
  for (let i = 0; i < parts.length; i++) {
    const candidate = parts.slice(i).join('.');
    if (isPublicSuffix(candidate)) return candidate;
  }
  return parts[parts.length - 1];
}

/**
 * 获取根域名（可注册域）。
 *
 * - `a.e.com` → `e.com`
 * - `foo.cc.cd` → `foo.cc.cd`（cc.cd 是公共后缀）
 * - `bar.foo.dpdns.org` → `foo.dpdns.org`
 * - `a.x.ck` → `a.x.ck`（`*.ck` 通配后缀生效时）
 */
export function getRootDomain(domainName: string): string {
  const normalized = normalizeDomain(domainName);
  const suffix = getPublicSuffix(normalized);
  if (normalized === suffix) return normalized;

  const rest = normalized.slice(0, normalized.length - suffix.length - 1);
  const labels = rest.split('.');
  if (labels.length === 0) return normalized;
  return labels[labels.length - 1] + '.' + suffix;
}

interface DomainLike {
  id: number;
  name: string;
}

export interface DomainGroup<T extends DomainLike> {
  /** 组名 = 可注册域（父域存在与否都一样） */
  name: string;
  /** 列表里存在同名父域时给出该行；虚拟组（父域未添加）为 null */
  parent: T | null;
  children: T[];
}

export interface DomainGroupResult<T extends DomainLike> {
  groups: DomainGroup<T>[];
  standalone: T[];
}

export interface GroupDomainsOptions {
  /**
   * true：无条件按可注册域造组——即使父域本身没有添加，也虚拟出 <e.com> 把子域收进去。
   * false（默认）：只有父域出现在列表里才成组（历史行为）。
   * 由用户开关决定，服务端只按参数执行。
   */
  virtualRoots?: boolean;
}

export function groupDomains<T extends DomainLike>(
  domains: T[],
  pinnedIds?: number[],
  options: GroupDomainsOptions = {},
): DomainGroupResult<T> {
  const pinnedSet = pinnedIds ? new Set(pinnedIds) : new Set<number>();
  const virtualRoots = options.virtualRoots === true;

  const domainsByName = new Map<string, T>();
  const nameCounts = new Map<string, number>();
  for (const domain of domains) {
    const key = normalizeDomain(domain.name);
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    if (!domainsByName.has(key)) domainsByName.set(key, domain);
  }

  const buckets = new Map<string, T[]>();
  for (const domain of domains) {
    const normalized = normalizeDomain(domain.name);
    const apex = getRootDomain(domain.name);
    // 自身就是可注册域：在虚拟模式下也要进组（作为组内第一行），否则它永远是 standalone
    if (apex === normalized && !virtualRoots) continue;
    if (!virtualRoots && !domainsByName.has(apex)) continue;
    const bucket = buckets.get(apex) ?? [];
    bucket.push(domain);
    buckets.set(apex, bucket);
  }

  const groups: DomainGroup<T>[] = [];
  const assignedIds = new Set<number>();

  for (const [apex, members] of buckets) {
    // 同名域名挂在多个账号时（合法：不同账号可能有同名域），不分组——
    // 否则只认第一条，另一条会以同名独立行出现，列表里出现「组头 + 同名行」的重复。
    if ((nameCounts.get(apex) ?? 0) > 1) continue;
    const parent = domainsByName.get(apex) ?? null;
    if (!parent && !virtualRoots) continue;
    // 只有它自己（没有子域）：不成组，保持独立行
    const onlySelf = members.length === 1 && normalizeDomain(members[0].name) === apex;
    if (onlySelf) continue;

    const children = parent
      ? [parent, ...members].filter((domain, index, list) => list.findIndex((item) => item.id === domain.id) === index)
      : [...members];

    children.sort((a, b) => {
      if (parent && a.id === parent.id) return -1;
      if (parent && b.id === parent.id) return 1;
      const aPinned = pinnedSet.has(a.id) ? 0 : 1;
      const bPinned = pinnedSet.has(b.id) ? 0 : 1;
      return aPinned - bPinned;
    });

    for (const child of children) assignedIds.add(child.id);
    groups.push({ name: apex, parent, children });
  }

  const standalone: T[] = domains.filter((domain) => !assignedIds.has(domain.id));
  return { groups, standalone };
}
