/**
 * 内网/保留地址的**前端预检**。
 *
 * 权威判定在服务端 `server/src/lib/dns/origin-group-core.ts` 的 `isPrivateAddress` /
 * `assertPublicTarget`——这里只是提前提示，不替代服务端校验（设计 §788：前端应提前校验）。
 * 规则与那边保持一致：IPv4 私网段、IPv6 回环/链路本地/唯一本地、localhost 与 .local。
 */
const PRIVATE_V4 = /^(10\.|127\.|192\.168\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[01])\.)/;
const PRIVATE_V6 = /^(::1$|::$|fe80:|fec0:|f[cd][0-9a-f]{2}:)/i;
const IPV4_SHAPE = /^\d{1,3}(\.\d{1,3}){3}$/;

export function looksPrivateOrigin(raw: string): boolean {
  const value = String(raw ?? '').trim().replace(/^\[(.*)\]$/, '$1');
  if (!value) return false;

  const lower = value.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.local')) return true;

  // 浏览器侧没有 node:net 的 isIP，用形状判断足够做提示
  if (IPV4_SHAPE.test(value)) return PRIVATE_V4.test(value);
  if (value.includes(':')) return PRIVATE_V6.test(value);
  return false;
}
