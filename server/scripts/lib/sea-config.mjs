/**
 * SEA 构建配置的纯逻辑（与 IO 分离，便于测试）。
 *
 * 两条经验规则，都是踩出来的：
 *
 * 1) 跨架构构建（在 arm64 的 macos-latest 上构建 macOS Intel 二进制）必须关掉 useCodeCache，
 *    因为 V8 code cache 与平台 + 架构强绑定。
 *
 * 2) **macOS 目标一律关掉 useCodeCache**。原生 arm64、签名有效、架构正确的情况下，
 *    带 code cache 的 SEA 二进制在 macOS 上仍然启动即 Segmentation fault（实测 run 39584653843）；
 *    同样的构建在 Linux 上可以正常跑。code cache 是在 postject 注入**之前**针对未注入的 node
 *    生成的，注入会改动二进制布局，macOS 对此比 Linux 严格。
 */

/**
 * @param {Record<string, unknown>} baseConfig 仓库里的 sea-config.json 内容
 * @param {{ isCrossArch: boolean, nodePlatform?: string }} options
 * @returns {{ config: Record<string, unknown>, modified: boolean, reason?: string }}
 */
export function resolveSeaConfig(baseConfig, { isCrossArch, nodePlatform }) {
  const config = { ...baseConfig };
  if (!config.useCodeCache) return { config, modified: false };

  const isMac = nodePlatform === 'darwin';
  if (!isCrossArch && !isMac) return { config, modified: false };

  config.useCodeCache = false;
  return {
    config,
    modified: true,
    reason: isMac
      ? 'macOS: SEA binaries with V8 code cache crash on startup (postject changes the binary layout)'
      : 'code cache is platform+arch specific; cross-arch builds must disable it',
  };
}

/** 目标是否与当前主机不同架构或不同平台 */
export function isCrossArchBuild(target, host = process) {
  return host.arch !== target.nodeArch || host.platform !== target.nodePlatform;
}
