import {
  TOP_NAMESPACES,
  RESERVED_TOP_NAMESPACES,
  isActionClass,
  type NamespaceClaim,
} from '../../types/namespace';
import { AVAILABLE_SERVICES } from '../../types/token';
import { isBrandedAction, type ActionDeclaration } from './types';

/**
 * 命名空间与动作名校验（单一定义源）。
 * 测试与 CLI 共用本文件，避免两处逻辑漂移。
 * 设计依据：docs/WORKFLOW_ENGINE_DESIGN.md §3.7.4.1 与计划 §5.2（A1–A11）
 */

export type ViolationKind =
  | 'not-whitelisted'
  | 'reserved'
  | 'double-claim'
  | 'dup-second'
  | 'unclaimed'
  | 'duplicate-name'
  | 'outside'
  | 'empty-second'
  | 'extra-second'
  | 'index-mismatch'
  | 'bad-service'
  | 'bad-class'
  | 'unbranded-handler';

export interface Violation {
  kind: ViolationKind;
  detail: string;
}

const NAME_RE = /^([a-z][a-z0-9]*)\.([a-z][a-zA-Z0-9]*)\.(.+)$/;

/** A0：命名空间授权链（白名单 / 一对一认领 / 预留未用 / 二级前缀不重复 / 全覆盖） */
export function validateNamespaceClaims(claims: readonly NamespaceClaim[]): Violation[] {
  const out: Violation[] = [];
  const owner = new Map<string, string>();

  for (const claim of claims) {
    if (!(TOP_NAMESPACES as readonly string[]).includes(claim.top)) {
      out.push({ kind: 'not-whitelisted', detail: `${claim.owner}: ${claim.top} 不在全局白名单` });
    }
    if ((RESERVED_TOP_NAMESPACES as readonly string[]).includes(claim.top)) {
      out.push({ kind: 'reserved', detail: `${claim.owner} 占用了预留前缀 ${claim.top}` });
    }
    if (!claim.second.length) {
      out.push({ kind: 'empty-second', detail: `${claim.owner} 未下派任何二级前缀` });
    }
    const prev = owner.get(claim.top);
    if (prev) {
      out.push({ kind: 'double-claim', detail: `${claim.top} 被 ${prev} 与 ${claim.owner} 同时认领` });
    } else {
      owner.set(claim.top, claim.owner);
    }
    const seen = new Set<string>();
    for (const second of claim.second) {
      if (seen.has(second)) {
        out.push({ kind: 'dup-second', detail: `${claim.top} 二级前缀重复: ${second}` });
      }
      seen.add(second);
    }
  }

  for (const top of TOP_NAMESPACES) {
    if (!owner.has(top)) out.push({ kind: 'unclaimed', detail: `${top} 未被任何子系统认领` });
  }
  return out;
}

/** A4：动作名全局唯一 */
export function validateActionUniqueness(names: readonly string[]): Violation[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name, count]) => ({ kind: 'duplicate-name' as const, detail: `动作名重复: ${name}（${count} 次）` }));
}

/** A1：动作名前两段必须命中某个模块下派的 (top, second) */
export function validateActionPlacement(names: readonly string[], claims: readonly NamespaceClaim[]): Violation[] {
  const allowed = new Map<string, Set<string>>();
  for (const claim of claims) {
    const set = allowed.get(claim.top) ?? new Set<string>();
    for (const second of claim.second) set.add(second);
    allowed.set(claim.top, set);
  }
  const out: Violation[] = [];
  for (const name of names) {
    const match = NAME_RE.exec(name);
    if (!match) {
      out.push({ kind: 'outside', detail: `${name} 不符合 <top>.<second>.<verb> 格式` });
      continue;
    }
    const top = match[1];
    const second = match[2];
    if (!allowed.get(top)?.has(second)) {
      out.push({ kind: 'outside', detail: `${name} 不在任何子系统下派的命名空间内` });
    }
  }
  return out;
}

/** A9：动作声明的 service / actionClass 必须合法 */
export function validateDeclarations(declarations: readonly ActionDeclaration[]): Violation[] {
  const out: Violation[] = [];
  for (const declaration of declarations) {
    if (!(AVAILABLE_SERVICES as readonly string[]).includes(declaration.service)) {
      out.push({ kind: 'bad-service', detail: `${declaration.name} 的服务权限非法: ${declaration.service}` });
    }
    if (!isActionClass(declaration.actionClass)) {
      out.push({ kind: 'bad-class', detail: `${declaration.name} 的动作分类非法: ${declaration.actionClass}` });
    }
  }
  return out;
}

export interface ModuleShape {
  namespace: { readonly owner: string; readonly top: string; readonly second: readonly string[] };
  declarations: ActionDeclaration[];
  handlers: Record<string, unknown>;
}

/**
 * A2 / A3 / A5 / A10：模块级双向一致
 * - A2：每个二级前缀至少有一个声明（ext 例外：提供商可不提供特有能力）
 * - A3：声明中出现的二级前缀不得多于下派
 * - A5：声明集合与索引集合双向一致
 * - A10：handler 必须由 defineAction() 产出
 */
export function validateModules(modules: readonly ModuleShape[], index: readonly ActionDeclaration[]): Violation[] {
  const out: Violation[] = [];

  for (const module of modules) {
    const top = module.namespace.top;
    const second = module.namespace.second;
    const declaredSeconds = new Set<string>();

    for (const declaration of module.declarations) {
      const match = NAME_RE.exec(declaration.name);
      if (!match) {
        out.push({ kind: 'outside', detail: `${declaration.name} 格式非法` });
        continue;
      }
      if (match[1] !== top) {
        out.push({ kind: 'outside', detail: `${declaration.name} 的顶级前缀不是 ${top}` });
      }
      if (!second.includes(match[2])) {
        out.push({ kind: 'extra-second', detail: `${declaration.name} 的二级前缀 ${match[2]} 未下派` });
      }
      declaredSeconds.add(match[2]);
    }

    if (top !== 'ext') {
      for (const candidate of second) {
        if (!declaredSeconds.has(candidate)) {
          out.push({ kind: 'empty-second', detail: `${top}.${candidate} 已下派但没有任何动作` });
        }
      }
    }

    for (const name of Object.keys(module.handlers)) {
      if (!module.declarations.some((d) => d.name === name)) {
        out.push({ kind: 'index-mismatch', detail: `handler ${name} 没有对应声明` });
      }
      if (!isBrandedAction(module.handlers[name])) {
        out.push({ kind: 'unbranded-handler', detail: `handler ${name} 未经 defineAction() 产出` });
      }
    }
  }

  const declaredNames = new Set(modules.flatMap((m) => m.declarations.map((d) => d.name)));
  const handlerNames = new Set(modules.flatMap((m) => Object.keys(m.handlers)));
  const indexNames = new Set(index.map((a) => a.name));

  for (const name of declaredNames) {
    if (!indexNames.has(name)) out.push({ kind: 'index-mismatch', detail: `声明 ${name} 未进入 ALL_ACTIONS 索引` });
    if (!handlerNames.has(name)) out.push({ kind: 'index-mismatch', detail: `声明 ${name} 没有对应 handler` });
  }
  for (const name of handlerNames) {
    if (!indexNames.has(name)) out.push({ kind: 'index-mismatch', detail: `handler ${name} 未进入 ALL_ACTIONS 索引` });
  }
  for (const name of indexNames) {
    if (!declaredNames.has(name)) out.push({ kind: 'index-mismatch', detail: `索引中的 ${name} 不属于任何模块` });
  }

  return out;
}

/** 汇总全部校验 */
export function validateAll(
  claims: readonly NamespaceClaim[],
  modules: readonly ModuleShape[],
  index: readonly ActionDeclaration[],
): Violation[] {
  const names = index.map((a) => a.name);
  return [
    ...validateNamespaceClaims(claims),
    ...validateActionUniqueness(names),
    ...validateActionPlacement(names, claims),
    ...validateDeclarations(index),
    ...validateModules(modules, index),
  ];
}