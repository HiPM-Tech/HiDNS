#!/usr/bin/env node
/**
 * GC 基准：量化 --max-semi-space-size 对「短命对象多」的代码路径的影响。
 *
 * 为什么单独做一个脚本：真实负载需要 DB + 登录态，CI 里不好稳定复现；
 * 但 GC 参数影响的是「分配速率与存活分布」，用几条每次请求都会跑的真实路径就能体现：
 *   normalizeDomain / getRootDomain  —— 域名归一与公共后缀解析，分配多、存活短
 *   renderTemplate                   —— 字符串拼接 + 正则
 *   resolveTokenPolicy               —— 小对象 + 数组
 *
 * 由 CI 用两组 NODE_OPTIONS 各跑一次做对比；本地也可直接跑。
 */
import { performance } from 'node:perf_hooks';

const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 200000);

const { normalizeDomain, getRootDomain } = await import('../dist/utils/domain.js');
const { renderTemplate } = await import('../dist/service/emailTemplates.js');
const { resolveTokenPolicy } = await import('../dist/service/token-policy.js');

const DOMAINS = [
  'www.example.com', 'a.b.c.dpdns.org', 'api.zhxc.site', 'cdn.example.co.uk',
  'mail.sub.example.com', 'node1.edge.internal.example.org',
];

function work(i) {
  const normalized = normalizeDomain(DOMAINS[i % DOMAINS.length]);
  getRootDomain(normalized);
  renderTemplate(
    { subject: 'HiDNS 验证码', body: '您的验证码是 {{code}}，{{ttlMinutes}} 分钟内有效。' },
    { code: String(i % 1000000), ttlMinutes: 10 },
  );
  resolveTokenPolicy({ allowedServices: ['dns:read', 'mcp:write'], maxRole: 1, userRole: 3 });
}

// 预热，避免把 JIT 编译算进结果
for (let i = 0; i < 20000; i += 1) work(i);

const start = performance.now();
for (let i = 0; i < ITERATIONS; i += 1) work(i);
const elapsed = performance.now() - start;

const mem = process.memoryUsage();
console.log(JSON.stringify({
  iterations: ITERATIONS,
  elapsedMs: Math.round(elapsed),
  opsPerSec: Math.round((ITERATIONS / elapsed) * 1000),
  rssMb: Math.round(mem.rss / 1048576),
  heapUsedMb: Math.round(mem.heapUsed / 1048576),
  nodeOptions: process.env.NODE_OPTIONS ?? '(default)',
}));