/**
 * SEA 构建配置的纯逻辑（与 IO 分离，便于测试）。
 *
 * 背景：V8 code cache 与平台 + 架构强绑定。跨架构构建（例如在 arm64 的 macos-latest
 * 上构建 macOS Intel 二进制）时，若仍把 code cache 写进 blob，目标机器启动会反序列化失败。
 * 这里把「什么情况下要关掉 useCodeCache」固化成函数，避免以后有人把它删掉。
 */

/**
 * @param {Record<string, unknown>} baseConfig 仓库里的 sea-config.json 内容
 * @param {{ isCrossArch: boolean }} options
 * @returns {{ config: Record<string, unknown>, modified: boolean, reason?: string }}
 */
export function resolveSeaConfig(baseConfig, { isCrossArch }) {
  const config = { ...baseConfig };
  if (!isCrossArch) return { config, modified: false };
  if (!config.useCodeCache) return { config, modified: false };

  config.useCodeCache = false;
  return {
    config,
    modified: true,
    reason: 'code cache is platform+arch specific; cross-arch builds must disable it',
  };
}

/** 目标是否与当前主机不同架构或不同平台 */
export function isCrossArchBuild(target, host = process) {
  return host.arch !== target.nodeArch || host.platform !== target.nodePlatform;
}
