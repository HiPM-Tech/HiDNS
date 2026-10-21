#!/usr/bin/env node
/**
 * CI 工作流监听器
 *
 * 用途：持续盯着 GitHub Actions 的运行状态，跑完就收敛并给出结论；
 * 有失败时把失败的作业与步骤直接指出来，避免每次手工 gh run view。
 *
 * 用法：
 *   node scripts/ci-watch.mjs                 # 看一次最新运行
 *   node scripts/ci-watch.mjs --watch         # 轮询直到全部收敛
 *   node scripts/ci-watch.mjs --watch --interval 30
 *   node scripts/ci-watch.mjs --fail-on-failure   # 有失败则 exit 1（可用于门禁）
 *   node scripts/ci-watch.mjs --limit 10      # 看最近 N 条
 *
 * 依赖 gh CLI（已登录）。没有 gh 时退化为公开 API（匿名，有限流）。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const WATCH = flag('--watch');
const FAIL_ON_FAILURE = flag('--fail-on-failure');
const LIMIT = Number(opt('--limit', '8'));
// 状态文件：记住上次看到过哪些 run，用来只报「新增」的运行。
// 持续监听时这才是有效信息——每次都把同样的 8 条重播一遍没有意义。
const STATE_PATH = opt('--state', join(process.cwd(), '.cache', 'ci-watch-state.json'));
const INTERVAL = Number(opt('--interval', '20'));
const MAX_WAIT_MIN = Number(opt('--max-wait', '120'));

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' });
}

function listRuns() {
  const json = gh([
    'run', 'list',
    '--limit', String(LIMIT),
    '--json', 'databaseId,name,status,conclusion,headSha,headBranch,createdAt,url,workflowName',
  ]);
  return JSON.parse(json);
}

function failedJobs(id) {
  try {
    const json = gh(['run', 'view', String(id), '--json', 'jobs']);
    const jobs = JSON.parse(json).jobs || [];
    return jobs
      .filter((j) => j.conclusion && j.conclusion !== 'success' && j.conclusion !== 'skipped')
      .map((j) => ({
        name: j.name,
        conclusion: j.conclusion,
        failedSteps: (j.steps || []).filter((s) => s.conclusion === 'failure').map((s) => s.name),
      }));
  } catch {
    return [];
  }
}

const ICON = { success: '✅', failure: '❌', cancelled: '⚪', skipped: '⏭️' };

function loadSeen() {
  try {
    if (!existsSync(STATE_PATH)) return new Set();
    const data = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return new Set(Array.isArray(data.seen) ? data.seen : []);
  } catch {
    return new Set();
  }
}

function saveSeen(ids) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify({ seen: [...ids].slice(-200), updatedAt: new Date().toISOString() }, null, 2));
  } catch {
    /* 状态文件写不了不影响主流程 */
  }
}

function render(runs, seen = new Set()) {
  const lines = [];
  for (const r of runs) {
    const state = r.status === 'completed' ? (ICON[r.conclusion] || '?') : '⏳';
    const raw = r.workflowName || r.name || 'workflow';
    const name = (raw.length > 36 ? `${raw.slice(0, 33)}...` : raw).padEnd(36);
    const isNew = seen.size > 0 && !seen.has(r.databaseId);
    lines.push(`${isNew ? '🆕 ' : ''}${state} ${name} ${r.headSha.slice(0, 7)}  ${r.headBranch}  ${r.status}/${r.conclusion || '-'}`);
    if (r.status === 'completed' && r.conclusion && r.conclusion !== 'success') {
      for (const j of failedJobs(r.databaseId)) {
        const steps = j.failedSteps.length ? ` （失败步骤：${j.failedSteps.join(', ')}）` : '';
        lines.push(`     ↳ ${j.name} => ${j.conclusion}${steps}`);
      }
    }
  }
  return lines.join('\n');
}

const started = Date.now();
let lastSignature = '';
const seen = loadSeen();

for (;;) {
  let runs;
  try {
    runs = listRuns();
  } catch (err) {
    console.error('获取运行列表失败：', err.message.split('\n')[0]);
    process.exit(2);
  }

  const signature = runs.map((r) => `${r.databaseId}:${r.status}:${r.conclusion}`).join('|');
  if (signature !== lastSignature) {
    const newRuns = runs.filter((r) => !seen.has(r.databaseId));
    console.log(`\n[${new Date().toISOString()}] ${runs.filter((r) => r.status !== 'completed').length} 个运行中，本次新增 ${newRuns.length} 条`);
    console.log(render(runs, seen));
    lastSignature = signature;
  }
  for (const r of runs) seen.add(r.databaseId);
  saveSeen(seen);

  const pending = runs.filter((r) => r.status !== 'completed');
  if (pending.length === 0) break;

  if (!WATCH) break;
  if (Date.now() - started > MAX_WAIT_MIN * 60_000) {
    console.log(`\n⚠️  已等待 ${MAX_WAIT_MIN} 分钟仍有 ${pending.length} 个未完成，先退出`);
    process.exit(3);
  }
  await new Promise((res) => setTimeout(res, INTERVAL * 1000));
}

// 结论只看**每个工作流最新的一次**：历史失败（比如修复前的红）不应该继续算作当前状态。
// 需要连历史一起看时加 --all。
const allRuns = listRuns();
const latestByWorkflow = new Map();
for (const r of allRuns) {
  const key = r.workflowName || r.name || 'workflow';
  if (!latestByWorkflow.has(key)) latestByWorkflow.set(key, r);
}
const considered = flag('--all') ? allRuns : [...latestByWorkflow.values()];
const failed = considered.filter((r) => r.conclusion && r.conclusion !== 'success' && r.conclusion !== 'skipped');
const pendingLeft = considered.filter((r) => r.status !== 'completed');

if (pendingLeft.length > 0) {
  console.log(`\n⏳ 仍有 ${pendingLeft.length} 个最新运行未完成`);
} else if (failed.length > 0) {
  console.log(`\n❌ ${failed.length} 个工作流的最新运行失败：${failed.map((r) => r.workflowName || r.name).join(', ')}`);
  if (FAIL_ON_FAILURE) process.exit(1);
} else {
  console.log(`\n✅ ${considered.length} 个工作流的最新运行均为 success`);
}
