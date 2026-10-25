import { execute, query } from './business-adapter';

/**
 * 动态线路缓存表（provider_lines）。
 *
 * 规则（见 root.ai.md「2.2 线路模型」）：
 * - 动态提供商拉取成功后写入本表，TTL 3600s；
 * - 拉取失败时对外只返回默认线路，5 分钟后由任务重试；
 * - 内置提供商不写本表。
 */
export interface ProviderLineRow {
  provider_type: string;
  line_id: string;
  line_name: string;
  updated_at: string | Date | number;
}

export const ProviderLineOperations = {
  async getByProvider(providerType: string): Promise<ProviderLineRow[]> {
    return await query<ProviderLineRow>(
      'SELECT provider_type, line_id, line_name, updated_at FROM provider_lines WHERE provider_type = ? ORDER BY id',
      [providerType],
    );
  },

  async getLastUpdatedAt(providerType: string): Promise<string | Date | number | null> {
    const rows = await query<{ updated_at: string | Date | number }>(
      'SELECT updated_at FROM provider_lines WHERE provider_type = ? ORDER BY updated_at DESC LIMIT 1',
      [providerType],
    );
    return rows[0]?.updated_at ?? null;
  },

  /** 覆盖某提供商的全部线路（先删后插，保证上游删掉的线路本地也消失） */
  async replaceForProvider(providerType: string, lines: Array<{ id: string; name?: string }>): Promise<number> {
    const seen = new Set<string>();
    const rows = lines
      .map((line) => ({ id: String(line.id ?? '').trim(), name: String(line.name ?? '').trim() }))
      .filter((line) => line.id && !seen.has(line.id) && (seen.add(line.id), true));
    await execute('DELETE FROM provider_lines WHERE provider_type = ?', [providerType]);
    for (const line of rows) {
      await execute(
        'INSERT INTO provider_lines (provider_type, line_id, line_name, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
        [providerType, line.id, line.name],
      );
    }
    return rows.length;
  },
};
