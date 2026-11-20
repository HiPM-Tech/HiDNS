/** 通用格式化工具（纯函数，禁止在组件内重复实现） */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const DAY_MS = 24 * HOUR;

/**
 * 解析后端时间字符串。
 *
 * SQLite 的 CURRENT_TIMESTAMP 产出 `YYYY-MM-DD HH:mm:ss`（UTC，**没有时区后缀**），
 * 浏览器会把这种字符串按本地时区解析，UTC+8 下整体偏移 8 小时（issue #60）。
 * 这里把「无时区后缀」的时间按 UTC 解释；已经带 Z / +08:00 的照常解析。
 */
export function parseServerTime(value?: string | null): Date | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const naive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed);
  const normalized = naive ? `${trimmed.replace(' ', 'T')}Z` : trimmed;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatRelative(iso?: string): string {
  const date = parseServerTime(iso);
  if (!date) return '—';
  const diff = Date.now() - date.getTime();
  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR)} 小时前`;
  return `${Math.floor(diff / DAY_MS)} 天前`;
}

export function formatDate(iso?: string): string {
  const date = parseServerTime(iso);
  if (!date) return '—';
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

export function daysUntil(iso?: string): number | null {
  const date = parseServerTime(iso);
  if (!date) return null;
  return Math.ceil((date.getTime() - Date.now()) / DAY_MS);
}

export function formatNumber(value?: number | null): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  return value.toLocaleString('zh-CN');
}