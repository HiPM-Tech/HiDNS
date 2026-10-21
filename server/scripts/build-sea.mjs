#!/usr/bin/env node
/**
 * SEA 二进制构建脚本
 *
 * 流程:
 *   1. pnpm build (tsc → dist/)
 *   2. node scripts/embed-client.mjs (生成 dist/embedded-client.js)
 *   3. esbuild 打包 dist/app.js + 所有纯 JS 依赖 → dist/bundle.cjs
 *   4. node --experimental-sea-config sea-config.json (生成 sea-prep.blob)
 *   5. 复制 Node.js 运行时
 *   6. postject 注入 blob → 最终二进制
 *
 * 用法:
 *   node scripts/build-sea.mjs win        # Windows x64
 *   node scripts/build-sea.mjs win-arm64  # Windows ARM64
 *   node scripts/build-sea.mjs linux      # Linux x64
 *   node scripts/build-sea.mjs macos      # macOS x64 (arm64)
 *   node scripts/build-sea.mjs macos-x64  # macOS x64 (intel)
 *   node scripts/build-sea.mjs all        # 所有平台
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { rcedit } from 'rcedit';
import https from 'https';

import { resolveSeaConfig } from './lib/sea-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const version = pkg.version;

/** 平台构建目标 */
const TARGETS = {
  win: {
    nodePlatform: 'win32',
    nodeArch: 'x64',
    binaryName: `HiDNS-${version}-win-x64.exe`,
    seaNodeBinary: [ // Node.js 24 LTS SEA 二进制下载 URL
      `https://nodejs.org/dist/v24.16.0/win-x64/node.exe`,
    ],
  },
  'win-arm64': {
    nodePlatform: 'win32',
    nodeArch: 'arm64',
    binaryName: `HiDNS-${version}-win-arm64.exe`,
    seaNodeBinary: [
      `https://nodejs.org/dist/v24.16.0/win-arm64/node.exe`,
    ],
  },
  linux: {
    nodePlatform: 'linux',
    nodeArch: 'x64',
    binaryName: `HiDNS-${version}-linux-x64`,
    seaNodeBinary: [
      `https://nodejs.org/dist/v24.16.0/node-v24.16.0-linux-x64.tar.gz`,
    ],
  },
  'linux-arm64': {
    nodePlatform: 'linux',
    nodeArch: 'arm64',
    binaryName: `HiDNS-${version}-linux-arm64`,
    seaNodeBinary: [
      `https://nodejs.org/dist/v24.16.0/node-v24.16.0-linux-arm64.tar.gz`,
    ],
  },
  macos: {
    nodePlatform: 'darwin',
    nodeArch: 'arm64',
    binaryName: `HiDNS-${version}-macos-arm64`,
    seaNodeBinary: [
      `https://nodejs.org/dist/v24.16.0/node-v24.16.0-darwin-arm64.tar.gz`,
    ],
  },
  'macos-x64': {
    nodePlatform: 'darwin',
    nodeArch: 'x64',
    binaryName: `HiDNS-${version}-macos-x64`,
    seaNodeBinary: [
      `https://nodejs.org/dist/v24.16.0/node-v24.16.0-darwin-x64.tar.gz`,
    ],
  },
};

/**
 * 执行 shell 命令并输出日志
 */
function run(cmd, label) {
  console.log(`\n🏗️  ${label || cmd}`);
  execSync(cmd, { cwd: root, stdio: 'inherit' });
}

/**
 * 下载文件
 */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const followRedirect = (currentUrl, redirectCount = 0) => {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }
      const file = fs.createWriteStream(dest);
      console.log(`   ⬇️  Downloading: ${currentUrl}`);
      https.get(currentUrl, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          // 跟随重定向
          file.close();
          fs.unlink(dest, () => {});
          const redirectUrl = new URL(response.headers.location, currentUrl).href;
          console.log(`   🔄 Redirecting to: ${redirectUrl}`);
          followRedirect(redirectUrl, redirectCount + 1);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed with status ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log(`   ✅ Downloaded: ${dest}`);
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    };
    followRedirect(url);
  });
}

/**
 * 获取当前平台 Node.js 二进制路径
 */
function getNodeBinary() {
  if (process.platform === 'win32') return 'node.exe';
  return 'node';
}

/**
 * 构建单个平台
 */
async function buildForPlatform(targetName) {
  const target = TARGETS[targetName];
  if (!target) {
    console.error(`❌ Unknown target: ${targetName}`);
    console.error(`   Available: ${Object.keys(TARGETS).join(', ')}`);
    process.exit(1);
  }

  const buildDir = path.join(root, 'dist', 'sea');
  const blobPath = path.join(root, 'dist', 'sea-prep.blob');
  const outputBinary = path.join(buildDir, target.binaryName);

  // 清理并创建构建目录
  if (fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true });
  }
  fs.mkdirSync(buildDir, { recursive: true });

  console.log(`\n═══════════════════════════════════════`);
  console.log(`  Building ${targetName}: ${target.binaryName}`);
  console.log(`═══════════════════════════════════════\n`);

  // Step 1: 编译 TypeScript
  run('pnpm build', 'Compiling TypeScript');

  // Step 2: 嵌入式客户端
  run('node scripts/embed-client.mjs', 'Embedding client build');

  // Step 3: esbuild 打包为单一 CJS
  //
  // 策略：
  // - 所有纯 JS 依赖 → 打包进 bundle.cjs（SEA 场景无需 node_modules）
  // - node:sqlite 是内置模块，无需 external
  // - 嵌入式客户端（dist/embedded-client.js）会被 esbuild 自动追踪打包

  const bundleCmd = [
    `npx esbuild dist/app.js`,
    `--bundle`,
    `--platform=node`,
    `--target=node24`,
    `--outfile=dist/bundle.cjs`,
    `--format=cjs`,
    `--legal-comments=none`,
    `--define:process.env.NODE_ENV="\\"production\\""`,
  ].join(' ');

  run(bundleCmd, 'Bundling with esbuild');

  // 目标架构与当前架构是否不同（含平台），必须在生成 blob 之前算出来：
  // V8 code cache 是与平台+架构绑定的，跨架构时若仍写进 blob，
  // 目标机器启动会因反序列化失败而直接崩（macOS Intel 二进制就是在 arm64 runner 上交叉构建的）。
  const isCrossArch = process.arch !== target.nodeArch || process.platform !== target.nodePlatform;

  // Step 4: 生成 SEA blob
  // 跨架构构建时显式关掉 useCodeCache —— 这类缓存只在同架构上可复用。
  const baseSeaConfig = JSON.parse(fs.readFileSync(path.join(root, 'sea-config.json'), 'utf-8'));
  const resolved = resolveSeaConfig(baseSeaConfig, { isCrossArch, nodePlatform: target.nodePlatform });
  let seaConfigPath = path.join(root, 'sea-config.json');
  if (resolved.modified) {
    seaConfigPath = path.join(root, 'dist', 'sea-config.cross.json');
    fs.writeFileSync(seaConfigPath, JSON.stringify(resolved.config, null, 2));
    console.log(`   ⚠️  ${resolved.reason}`);
  }
  run(`node --experimental-sea-config "${seaConfigPath}"`, 'Generating SEA blob');

  // Step 5: 获取目标架构的 Node.js 运行时
  // - 如果目标架构与当前架构相同，直接复制本地 Node.js
  // - 如果不同（跨架构构建），从 seaNodeBinary 下载目标架构的 Node.js
  let nodeBinaryPath;
  if (isCrossArch && target.seaNodeBinary?.length > 0) {
    // 跨架构构建：下载目标架构的 Node.js 运行时
    const downloadUrl = target.seaNodeBinary[0];
    // 从 URL 推断下载文件扩展名：.tar.gz → 目录名, .exe → .exe, 否则无扩展名
    let downloadedBinary;
    if (downloadUrl.endsWith('.tar.gz')) {
      downloadedBinary = path.join(buildDir, 'node.tar.gz');
    } else if (downloadUrl.endsWith('.tar.xz')) {
      downloadedBinary = path.join(buildDir, 'node.tar.xz');
    } else {
      const ext = target.nodePlatform === 'win32' ? '.exe' : '';
      downloadedBinary = path.join(buildDir, `node${ext}`);
    }
    await downloadFile(downloadUrl, downloadedBinary);
    nodeBinaryPath = downloadedBinary;
    console.log(`   🔄 Cross-arch build: ${process.arch} → ${target.nodeArch}`);
  } else {
    // 同架构构建：使用本地 Node.js
    nodeBinaryPath = process.execPath;
    console.log(`\n📦 Using local Node.js runtime: ${nodeBinaryPath}`);
  }

  // 复制 Node.js 运行时到输出二进制
  let finalBinaryPath = nodeBinaryPath;

  // 对于 tarball（macOS/Linux），解压后提取 bin/node
  if (nodeBinaryPath.endsWith('.tar.gz') || nodeBinaryPath.endsWith('.tar.xz')) {
    console.log(`   📦 Extracting tarball: ${nodeBinaryPath}`);
    const extractDir = path.join(buildDir, 'node-extracted');
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true });
    fs.mkdirSync(extractDir, { recursive: true });
    // 用 xf 而不是 xzf：让 tar 自己识别压缩格式（nodejs.org 同时提供 .tar.gz 与 .tar.xz）
    execSync(`tar xf "${nodeBinaryPath}" -C "${extractDir}"`, { stdio: 'inherit' });
    const dirs = fs.readdirSync(extractDir);
    const nodeDir = dirs.find(d => d.startsWith('node-v'));
    if (!nodeDir) throw new Error('Could not find node directory in extracted tarball');
    finalBinaryPath = path.join(extractDir, nodeDir, 'bin', 'node');
    console.log(`   ✅ Extracted: ${finalBinaryPath}`);
  }

  fs.copyFileSync(finalBinaryPath, outputBinary);

  // 权限设置 (POSIX)
  if (target.nodePlatform !== 'win32') {
    fs.chmodSync(outputBinary, 0o755);
  }

  // Step 5b: Windows 平台 — 在注入 SEA blob 前设置应用信息（产品名、版权、图标）
  // 必须在 postject 注入之前执行，因为 rcedit 无法处理 SEA 注入后的 PE 格式
  if (targetName === 'win' || targetName === 'win-arm64') {
    console.log(`\n🎨 Setting Windows executable resources...`);
    try {
      const clientPublic = path.resolve(root, '..', 'client', 'public');
      const iconPath = path.join(clientPublic, 'favicon.ico');
      const { rcedit } = await import('rcedit');
      await rcedit(outputBinary, {
        'version-string': {
          'ProductName': 'HiDNS',
          'CompanyName': 'HiPM-Tech',
          'LegalCopyright': `© ${new Date().getFullYear()} https://github.com/HiPM-Tech. All Rights Reserved.`,
          'FileDescription': 'HiDNS - DNS Management System',
          'ProductVersion': version,
          'FileVersion': version,
          'OriginalFilename': target.binaryName,
          'InternalName': 'HiDNS',
        },
        'file-version': version,
        'product-version': version,
        icon: fs.existsSync(iconPath) ? iconPath : undefined,
        'requested-execution-level': 'asInvoker',
      });
      console.log(`   ✅ ProductName: HiDNS`);
      console.log(`   ✅ Copyright: © ${new Date().getFullYear()} https://github.com/HiPM-Tech`);
      console.log(`   ✅ Icon: ${fs.existsSync(iconPath) ? iconPath : 'skipped (not found)'}`);
    } catch (err) {
      console.warn(`   ⚠️  Failed to set resources:`, err.message);
    }
  }

  // Step 6: postject 注入 blob
  const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
  const isMacTarget = target.nodePlatform === 'darwin';
  const postjectArgs = [
    outputBinary,
    'NODE_SEA_BLOB',
    blobPath,
    `--sentinel-fuse ${fuse}`,
  ];
  if (isMacTarget) {
    postjectArgs.push('--macho-segment-name NODE_SEA_BLOB');
  }

  // macOS：注入前必须先去掉 nodejs.org 自带的 ad-hoc 签名。
  // 直接往已签名的 Mach-O 里写数据会让签名失效，内核在 execve 阶段就会杀掉进程
  // （表现为双击没反应 / 「已损坏，无法打开」/ killed: 9）。
  // 官方 SEA 流程就是：remove-signature → postject → 重新 ad-hoc 签名。
  if (isMacTarget && process.platform === 'darwin') {
    console.log('\n🔏 Removing existing Mach-O signature (required before injection)');
    try {
      execSync(`codesign --remove-signature "${outputBinary}"`, { stdio: 'pipe' });
      console.log('   ✅ Signature removed');
    } catch (err) {
      // 未签名时该命令会失败，属于预期情况
      console.warn(`   ⚠️  remove-signature skipped: ${err.message.split('\n')[0]}`);
    }
  }

  run(`npx postject ${postjectArgs.join(' ')}`, 'Injecting SEA blob');

  // macOS：注入后必须重新 ad-hoc 签名，否则产物不可执行。
  if (isMacTarget && process.platform === 'darwin') {
    run(`codesign --force --sign - "${outputBinary}"`, 'Ad-hoc signing');
    run(`codesign --verify --verbose=2 "${outputBinary}"`, 'Verifying signature');
    console.log('   ✅ Signed and verified');
  } else if (isMacTarget) {
    console.warn('   ⚠️  macOS target built on a non-macOS host: signature steps skipped, the binary will NOT run on macOS');
  }

  // 清理临时文件
  const filesToClean = ['dist/bundle.cjs', 'dist/sea-prep.blob', 'dist/embedded-client.js'];
  for (const f of filesToClean) {
    const fp = path.join(root, f);
    if (fs.existsSync(fp)) fs.rmSync(fp);
  }

  console.log(`\n✅ ${target.binaryName} built successfully!`);
  console.log(`   Output: ${outputBinary}`);
  console.log(`   Size: ${(fs.statSync(outputBinary).size / 1024 / 1024).toFixed(1)} MB`);
}

// ── main ──
const targetArg = process.argv[2] || '';

if (targetArg === 'all') {
  console.log('Building for all platforms...');
  // 跨平台构建只能用各自的原生 Node.js
  for (const key of Object.keys(TARGETS)) {
    console.log(`\n========================================`);
    console.log(`  Target: ${key}`);
    console.log(`========================================`);
    buildForPlatform(key).catch(e => {
      console.error(`❌ Failed to build ${key}:`, e.message);
    });
  }
} else if (TARGETS[targetArg]) {
  buildForPlatform(targetArg).catch(e => { console.error('Build failed:', e.message); process.exit(1); });
} else {
  // 自动检测当前平台
  const platformMap = {
    win32: process.arch === 'arm64' ? 'win-arm64' : 'win',
    linux: process.arch === 'arm64' ? 'linux-arm64' : 'linux',
    darwin: 'macos',
  };
  const detected = platformMap[process.platform];
  if (detected && TARGETS[detected]) {
    buildForPlatform(detected).catch(e => { console.error('Build failed:', e.message); process.exit(1); });
  } else {
    console.log('Available targets:');
    for (const key of Object.keys(TARGETS)) {
      console.log(`  node scripts/build-sea.mjs ${key}`);
    }
    console.log(`  node scripts/build-sea.mjs all`);
    console.log(`\nDetected platform: ${process.platform} (${detected ? '→ ' + detected : 'not supported'})`);
  }
}