import fs from 'node:fs';
import path from 'node:path';

/**
 * 解析随仓库分发的静态资产目录（图标、数据快照等）。
 *
 * 为什么需要候选列表：同一份代码有三种运行形态，__dirname 各不相同——
 *   ts-node  : server/src/routes      → server/src/<segments>
 *   tsc 产物 : server/dist/routes     → server/dist/<segments>
 *   SEA 单文件: <任意>                 → 与代码同级的 <segments>
 *
 * 只写 `path.join(__dirname, '..', ...)` 在第一种与第二种形态下是对的，
 * 但打进单文件后 __dirname 变成进程启动目录，路径直接错位（图标 404、快照读不到）。
 * 这里按「先精确、后兜底」列出候选，命中第一个存在的目录。
 */
export function resolveAssetDir(...segments: string[]): string | null {
  const candidates = [
    // 单文件 / 与 app.cjs 同级部署（Docker 镜像：/app/dist/lib/dns/providers）
    path.resolve(__dirname, '..', 'dist', ...segments),
    path.resolve(__dirname, ...segments),
    // tsc 产物：dist/routes → dist/<segments>
    path.resolve(__dirname, '..', ...segments),
    // 以工作目录为基准（node server/dist/app.js、pnpm dev 等）
    path.resolve(process.cwd(), 'server', 'dist', ...segments),
    path.resolve(process.cwd(), 'server', 'src', ...segments),
    path.resolve(process.cwd(), 'dist', ...segments),
  ];

  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir)) return dir;
    } catch {
      // 忽略权限等异常，继续试下一个
    }
  }
  return null;
}
