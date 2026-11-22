#!/usr/bin/env node
/**
 * 服务端单文件打包（esbuild）。
 *
 * 目的：Docker 镜像不再需要 node_modules。
 *   - 服务端 22 个运行时依赖全部是纯 JS（bcryptjs / mysql2 / pg 都不是原生模块），
 *     因此可以完整 bundle 进一个文件；
 *   - 唯一不能 bundle 的是 swagger-ui-dist 的静态资源（浏览器直接加载的 html/js/css），
 *     它在下面被标为 external，由镜像单独提供。
 *
 * 前置：先跑 `tsc`（pnpm build）生成 dist/。
 */
import { build } from 'esbuild';
import { rmSync, mkdirSync, statSync, existsSync, cpSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const entry = path.join(root, 'dist', 'app.js');
const outDir = path.join(root, 'dist-bundle');
const outFile = path.join(outDir, 'app.cjs');

if (!existsSync(entry)) {
  console.error('✖ 找不到 dist/app.js，请先执行 pnpm build（tsc）');
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: outFile,
  minify: true,
  legalComments: 'none',
  // 只有静态资源需要留在文件系统里。
  // 注意要同时匹配子路径：swagger-ui-express 会 require('swagger-ui-dist/absolute-path')，
  // 只写包名的话这个子模块会被当成「找不到」而在启动时抛 MODULE_NOT_FOUND。
  external: ['swagger-ui-dist', 'swagger-ui-dist/*'],
  logLevel: 'warning',
});

// 运行时按文件路径读取的数据文件（public suffix 快照等）无法被内联，随 bundle 一起复制
const dataSrc = path.join(root, 'src', 'data');
if (existsSync(dataSrc)) {
  cpSync(dataSrc, path.join(outDir, 'data'), { recursive: true });
}

const size = statSync(outFile).size;
console.log(`✔ 服务端单文件打包完成：dist-bundle/app.cjs（${(size / 1048576).toFixed(1)} MB）`);
