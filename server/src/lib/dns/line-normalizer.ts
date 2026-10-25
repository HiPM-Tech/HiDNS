/**
 * 线路归一中间层。
 *
 * 职责边界：
 * - 只处理「默认线路」的归一：调用方传入 空 / '0' / '默认' 时，替换为适配器自己声明的默认线路值；
 * - 不接管各适配器的默认线路定义：默认值由适配器内部常量（DEFAULT_LINE）提供；
 * - 不改变上游真实线路空间：动态/内嵌线路列表、上游 ID/名称字典仍由适配器维护；
 * - 其它值原样透传，交给适配器/上游校验。
 */
export function normalizeLine(line: string | null | undefined, defaultLine: string): string {
  const trimmed = typeof line === 'string' ? line.trim() : '';
  if (!trimmed || trimmed === '0' || trimmed === '默认') return defaultLine;
  return trimmed;
}

/** 兼容旧调用名（语义完全一致） */
export const resolveProviderLine = normalizeLine;
