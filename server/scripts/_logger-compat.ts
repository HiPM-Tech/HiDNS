import { createLogger } from '../src/lib/logger';

/**
 * 兼容层：CI 的生命周期脚本（test-init / test-seed / ...）历史上用的是
 * `log.info(标签, 消息, 数据)` 这套三参签名，而 src/lib/logger 现在只导出
 * `createLogger(模块)` 且签名是 `info(消息, 数据)`。
 *
 * 这里做一次薄适配，避免去改 6 个脚本里的 70+ 处调用点。
 */
function make(tag: string) {
  const base = createLogger(tag);
  return {
    trace: (message: string, data?: unknown) => base.trace(message, data),
    debug: (message: string, data?: unknown) => base.debug(message, data),
    info: (message: string, data?: unknown) => base.info(message, data),
    warn: (message: string, data?: unknown) => base.warn(message, data),
    error: (message: string, data?: unknown) => base.error(message, data),
  };
}

const cache = new Map<string, ReturnType<typeof make>>();

/** 与旧 API 同形：第一个参数是标签（等价于日志模块名） */
export const log = {
  trace: (tag: string, message: string, data?: unknown) => get(tag).trace(message, data),
  debug: (tag: string, message: string, data?: unknown) => get(tag).debug(message, data),
  info: (tag: string, message: string, data?: unknown) => get(tag).info(message, data),
  warn: (tag: string, message: string, data?: unknown) => get(tag).warn(message, data),
  error: (tag: string, message: string, data?: unknown) => get(tag).error(message, data),
};

function get(tag: string) {
  let logger = cache.get(tag);
  if (!logger) {
    logger = make(tag);
    cache.set(tag, logger);
  }
  return logger;
}
