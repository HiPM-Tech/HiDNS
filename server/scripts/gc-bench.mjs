#!/usr/bin/env node
/**
 * GC 基准：量化 V8 参数对「分配密集、对象短命」路径的影响。
 *
 * 为什么单独做一个脚本：真实负载需要 DB + 登录态，CI 里不好稳定复现；
 * 但 GC 参数影响的是「分配速率与存活分布」，用几条每次请求都会跑的真实路径就能体现：
 *   normalizeDomain / getRootDomain  —— 域名归一与公共后缀解析
 *   renderTemplate                   —— 字符串拼接 + 正则
 *   resolveTokenPolicy               —— 小对象 + 数组
 *
 * 为什么要多轮取中位数：GitHub runner 的 CPU 分配不稳定，同代码同参数两次跑可能差 3~15%。
 * 单轮数字只能看「谁快谁慢」，不能看「快多少」。5 轮取中位数 + 输出 GC 次数后，
 * 结论才有可比性。
 */
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 200000);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 5);

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

// 多轮取中位数：GitHub runner 的 CPU 分配不稳定，单轮数字只能看「谁快谁慢」
const roundMs = [];
for (let round = 0; round < ROUNDS; round += 1) {
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i += 1) work(i);
  roundMs.push(performance.now() - start);
}

const sorted = [...roundMs].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
const totalIterations = ITERATIONS * ROUNDS;
const mem = process.memoryUsage();

const result = {
  iterations: totalIterations,
  rounds: ROUNDS,
  roundMs: roundMs.map((v) => Math.round(v)),
  medianMs: Math.round(median),
  opsPerSec: Math.round((ITERATIONS / median) * 1000),
  rssMb: Math.round(mem.rss / 1048576),
  heapUsedMb: Math.round(mem.heapUsed / 1048576),
  nodeOptions: process.env.NODE_OPTIONS ?? '(default)',
};

// JSON 单独落盘：CI 里会用 --trace-gc，stdout 会被 GC 追踪行占满，
// 从文件读结果比从混合输出里 grep 更稳。
if (process.env.BENCH_OUT) {
  writeFileSync(process.env.BENCH_OUT, JSON.stringify(result));
}
console.log(JSON.stringify(result));