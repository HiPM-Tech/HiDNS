import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * 架构守卫：提供商实现不得**直接** import 业务适配层（BAL）与服务层的适配器服务。
 *
 * 与评审结论对齐，避免夸大保证：
 * - 约束的是**直接依赖**。提供商经 `lib/dns/account-context` 间接拿到账号与适配器是允许的
 *   —— root.ai.md §276 要求「扩展能力实现留在提供商目录内」，把实现搬走反而违规。
 * - 真正要防的是：每个提供商各自去 BAL 里捞凭据，把「谁有资格读凭据」散落到 N 个提供商里。
 *
 * 与旧版的区别：旧版对整文件文本做子串匹配，既有漏检（`from '../../db/bal'` 不带尾斜杠、
 * 非 .ts 扩展名、__tests__ 目录）又有误报（注释里出现关键字就红）。这里解析 import 目标
 * 并归一化路径后比对前缀，且自带反例测试证明它抓得住。
 */

const PROVIDERS_DIR = resolve(process.cwd(), 'src', 'lib', 'dns', 'providers');
const SRC_DIR = resolve(process.cwd(), 'src');

/** 禁止直接依赖的目录（相对 src） */
const FORBIDDEN_DIRS = [['db', 'bal'].join(sep), ['service', 'dns-provider-service'].join(sep)];

const SOURCE_EXT = /\.(ts|tsx|mts|cts)$/;

export function walkProviders(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkProviders(full, out);
    else if (SOURCE_EXT.test(name) && !/\.test\.(ts|tsx|mts|cts)$/.test(name)) out.push(full);
  }
  return out;
}

/** 去掉注释，避免「注释里提到关键字」造成误报 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 抽出所有模块说明符：静态 import / export from / 动态 import() / require() */
export function importSpecifiers(source: string): string[] {
  const clean = stripComments(source);
  const out: string[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of clean.matchAll(pattern)) out.push(match[1]);
  }
  return out;
}

/** 该说明符（相对 file 解析后）是否落在禁止目录 */
export function isForbiddenSpecifier(spec: string, file: string): boolean {
  if (!spec.startsWith('.')) return false;
  const rel = relative(SRC_DIR, resolve(dirname(file), spec));
  return FORBIDDEN_DIRS.some((dir) => rel === dir || rel.startsWith(dir + sep));
}

describe('守卫自身的判别力', () => {
  // dirname 是 providers/tencenteo；到 src/ 需要 4 层：tencenteo → providers → dns → lib → src
  const file = join(PROVIDERS_DIR, 'tencenteo', 'extra.ts');
  const toSrc = '../../../..';

  it('带尾斜杠与不带尾斜杠的 BAL 都能抓到', () => {
    expect(isForbiddenSpecifier(toSrc + '/db/bal/business-adapter', file)).toBe(true);
    expect(isForbiddenSpecifier(toSrc + '/db/bal', file)).toBe(true);
  });

  it('dns-provider-service 能抓到', () => {
    expect(isForbiddenSpecifier(toSrc + '/service/dns-provider-service', file)).toBe(true);
  });

  it('其它 service 子模块不算违规（调度器基类是既有模式）', () => {
    const schedulerFile = join(PROVIDERS_DIR, 'dnshe', 'scheduler.ts');
    expect(isForbiddenSpecifier('../../../../service/renewalScheduler', schedulerFile)).toBe(false);
  });

  it('lib/dns 子功能与同目录相对导入不算违规', () => {
    expect(isForbiddenSpecifier('../../account-context', file)).toBe(false);
    expect(isForbiddenSpecifier('./adapter', file)).toBe(false);
  });

  it('注释里出现关键字不会误报', () => {
    const src = ['// 不要 import ../../db/bal/business-adapter', '/* 见 ../../db/bal */', 'import { x } from "./adapter";'].join('\n');
    expect(importSpecifiers(src)).toEqual(['./adapter']);
  });

  it('动态 import 与 require 也能抓到', () => {
    expect(importSpecifiers('await import("../../db/bal")')).toEqual(['../../db/bal']);
    expect(importSpecifiers('const x = require("../../service/dns-provider-service")')).toEqual([
      '../../service/dns-provider-service',
    ]);
  });
});

describe('提供商层的直接依赖', () => {
  const files = walkProviders(PROVIDERS_DIR);

  it('扫描到的提供商文件数量合理（防止守卫空转）', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('没有任何提供商文件直接 import BAL 或 dns-provider-service', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (isForbiddenSpecifier(spec, file)) offenders.push(relative(PROVIDERS_DIR, file) + ' -> ' + spec);
      }
    }
    expect(offenders).toEqual([]);
  });
});
