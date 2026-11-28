import { createLogger } from '../../lib/logger';
import { taskManager } from '../taskManager';
import { buildSnapshot } from './cache';
import { getDatabaseStats, getLatestPctMetrics } from '../../db/bal/resource-metrics-operations';
import os from 'os';

const log = createLogger('RESOURCE').sub('Collector');
const cpuCount = os.cpus().length;

let lastCpuUsage: NodeJS.CpuUsage | null = null;
let lastCpuTime = 0;

function getCpuPercent(): number | null {
  try {
    const current = process.cpuUsage();
    const now = Date.now();
    if (!lastCpuUsage) {
      lastCpuUsage = current;
      lastCpuTime = now;
      return null;
    }
    const cpuDeltaUs = current.user - lastCpuUsage.user + current.system - lastCpuUsage.system;
    const timeDeltaMs = now - lastCpuTime;
    lastCpuUsage = current;
    lastCpuTime = now;
    if (timeDeltaMs <= 0) return null;
    // 微秒 -> 毫秒 CPU 时间 / 毫秒级 wall 时间 -> 百分比，除以核心数得单核等效
    const percent = (cpuDeltaUs / 1000 / timeDeltaMs) * 100 / cpuCount;
    // 保留一位小数：空闲服务通常在 0.x%，Math.round 会把它压成 0，
    // 曲线就会是一条恒为 0 的直线（社区反馈「资源占用一直是平的」）。
    return Math.max(0, Math.round(percent * 10) / 10);
  } catch (err) {
    log.warn('Failed to calculate CPU usage', { error: err });
    return null;
  }
}

function getSysUsage(): { cpu: number | null; memPct: number | null; memMb: number | null; disk: number | null; uptime: number | null } {
  try {
    const usage = process.memoryUsage();
    const totalMem = os.totalmem();
    const memMb = Math.round(usage.rss / 1024 / 1024 * 100) / 100;
    const memPct = totalMem > 0 ? Math.round((usage.rss / totalMem) * 1000) / 10 : null;
    return {
      cpu: getCpuPercent(),
      memPct,
      memMb,
      disk: null,
      uptime: process.uptime() ? Math.round(process.uptime()) : null,
    };
  } catch (err) {
    log.warn('Failed to collect system usage', { error: err });
    return { cpu: null, memPct: null, memMb: null, disk: null, uptime: null };
  }
}

export async function collectSnapshot() {
  const sys = getSysUsage();
  const tq = taskManager.getQueuedCount();
  const db = getDatabaseStats();
  const snapshot = buildSnapshot(sys, tq, db.queries, db.errors, db.reads, db.writes);

  // 从数据库读取最新历史百分位，逐字段覆盖 RingBuffer 实时计算值
  // 仅当数据库有值时才覆盖，避免 NULL 覆盖 RingBuffer 实时数据
  try {
    const pct = await getLatestPctMetrics();
    if (pct.http_p50_ms != null) snapshot.http_p50_ms = pct.http_p50_ms;
    if (pct.http_p95_ms != null) snapshot.http_p95_ms = pct.http_p95_ms;
    if (pct.http_p99_ms != null) snapshot.http_p99_ms = pct.http_p99_ms;
    if (pct.dns_p50_ms != null) snapshot.dns_p50_ms = pct.dns_p50_ms;
    if (pct.dns_p95_ms != null) snapshot.dns_p95_ms = pct.dns_p95_ms;
    if (pct.dns_p99_ms != null) snapshot.dns_p99_ms = pct.dns_p99_ms;
    if (pct.dns_encrypted_p50_ms != null) snapshot.dns_encrypted_p50_ms = pct.dns_encrypted_p50_ms;
    if (pct.dns_encrypted_p95_ms != null) snapshot.dns_encrypted_p95_ms = pct.dns_encrypted_p95_ms;
    if (pct.dns_encrypted_p99_ms != null) snapshot.dns_encrypted_p99_ms = pct.dns_encrypted_p99_ms;
    if (pct.dns_plain_p50_ms != null) snapshot.dns_plain_p50_ms = pct.dns_plain_p50_ms;
    if (pct.dns_plain_p95_ms != null) snapshot.dns_plain_p95_ms = pct.dns_plain_p95_ms;
    if (pct.dns_plain_p99_ms != null) snapshot.dns_plain_p99_ms = pct.dns_plain_p99_ms;
  } catch {
    // 数据库无历史数据时保留 RingBuffer 值
  }

  return snapshot;
}
