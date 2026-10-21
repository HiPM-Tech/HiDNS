/**
 * 打包进发布产物的 Node.js 运行时版本（单一来源）。
 *
 * 安全底线 MIN_SECURE_NODE_VERSION 来自 Node.js 2026-10-20 安全版本 v24.22.1，
 * 它修复了下列影响本项目的高危/中危项：
 *   - CVE-2026-111497 (high)   Brotli 解码越界写可致 RCE —— 出站 HTTP 会解压响应
 *   - CVE-2026-105483 (high)   TLS 证书主机名校验：IP 写成全角数字时被绕过
 *   - CVE-2026-106069 (high)   TLS 证书主机名校验：主机松散解析为 IP 时被绕过
 *   - CVE-2026-105482 (high)   dns.resolve 遇到含 NUL 的名字会截断
 *   - CVE-2026-106074 (medium) randomUUID/randomInt 的熵缓存被写进 SEA 快照，
 *                              导致每个进程重复相同的随机值 —— 我们正是以 SEA 形态分发
 * 公告：https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
 */
export const MIN_SECURE_NODE_VERSION = 'v24.22.1';

/** 当前实际打包的版本；升级时只改这里与 .github/workflows/release.yml 的 env */
export const NODE_SEA_VERSION = 'v24.22.1';

/** 解析 vX.Y.Z → [X, Y, Z]；无法解析返回 null */
export function parseNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? '').trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** version 是否 ≥ floor（按语义化版本逐段比较） */
export function isAtLeast(version, floor) {
  const a = parseNodeVersion(version);
  const b = parseNodeVersion(floor);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}
