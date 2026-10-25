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

/**
 * 线路列表归一（默认线路由中间层统一改写）：
 * - 默认线路统一改写为 name='默认'，并固定排在首位；上游原名（全网默认/Default/default_view…）不直接透出
 * - 默认线路缺失时由中间层补一条，保证前端始终有且只有一条默认线路
 * - 其它线路按 id 去重、丢弃空 id，名称缺省回填 id
 */
export function normalizeLineList<T extends { id: string; name?: string }>(
  lines: T[],
  defaultLine: string,
): Array<{ id: string; name: string }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; name: string }> = [];
  for (const raw of lines) {
    const id = String(raw.id ?? '').trim();
    if (!id || id === defaultLine || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: String(raw.name ?? '').trim() || id });
  }
  if (!defaultLine) return out;
  return [{ id: defaultLine, name: '默认' }, ...out];
}
