/**
 * DNS 账号配置的读写归一化（纯函数，便于单测）。
 *
 * 背景：GET /api/accounts 会把 config 的每个值掩成 '***'；前端编辑账号时会把这份
 * 掩码原样回传。若服务端不识别占位符，会拿 '***' 去验凭据（必然失败），
 * 或在校验宽松的 provider 上把凭据写成 '***'（不可逆）。
 */

/** 掩码占位符：表示「该字段未修改」 */
export const MASKED_CONFIG_VALUE = '***';

/** 读取账号 config（MySQL 返回对象、SQLite/PG 返回字符串）；坏数据按空对象处理 */
export function parseConfigRecord(config: unknown): Record<string, unknown> {
  if (!config) return {};
  if (typeof config === 'string') {
    try {
      const parsed = JSON.parse(config) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (typeof config !== 'object' || Array.isArray(config)) return {};
  return config as Record<string, unknown>;
}

/**
 * 合并「掩码占位」的配置更新：
 * - 值为 `***` 且原配置里有同名键 → 沿用原值（未修改）；
 * - 值为 `***` 且原配置里没有 → 丢弃该键（避免把占位符写进库）；
 * - 其余键按传入值覆盖。
 */
export function mergeMaskedConfig(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === MASKED_CONFIG_VALUE) {
      if (key in existing) merged[key] = existing[key];
      continue;
    }
    merged[key] = value;
  }
  return merged;
}
