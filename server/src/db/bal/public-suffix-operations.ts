import { execute, query } from './business-adapter';

/**
 * 公共后缀表（public_suffixes）。
 *
 * 用途：域名「可注册域」判定（分组、WHOIS 顶域识别）。
 * 数据来源：定时任务从上游列表下拉入库；代码里的内置清单只用于「表为空时播种」，
 * 不作为运行时真值——这样新增 TLD / 多段后缀不必发版。
 */
export interface PublicSuffixRow {
  suffix: string;
  source: string;
}

export const PublicSuffixOperations = {
  /** 全表读取（运行时会被加载进内存集合，避免每次解析都查库） */
  async getAll(): Promise<PublicSuffixRow[]> {
    return await query<PublicSuffixRow>('SELECT suffix, source FROM public_suffixes');
  },

  async count(): Promise<number> {
    const rows = await query<{ total: number }>('SELECT COUNT(*) AS total FROM public_suffixes');
    return Number(rows[0]?.total ?? 0);
  },

  /** 播种：只插入不存在的后缀（幂等，可重复调用） */
  async seed(list: string[], source = 'builtin'): Promise<number> {
    let inserted = 0;
    for (const suffix of list) {
      const normalized = suffix.trim().toLowerCase();
      if (!normalized) continue;
      const existing = await query<{ suffix: string }>(
        'SELECT suffix FROM public_suffixes WHERE suffix = ?',
        [normalized],
      );
      if (existing.length > 0) continue;
      await execute(
        'INSERT INTO public_suffixes (suffix, source, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
        [normalized, source],
      );
      inserted++;
    }
    return inserted;
  },

  /**
   * 用上游清单覆盖某个来源的全部记录：先删后插，保证「上游删掉的后缀」在本地也消失。
   * 整批在调用方拼好再一次性写入，避免逐条往返。
   */
  async replaceSource(source: string, list: string[]): Promise<number> {
    const normalized = [...new Set(list.map((item) => item.trim().toLowerCase()).filter(Boolean))];
    await execute('DELETE FROM public_suffixes WHERE source = ?', [source]);
    for (const suffix of normalized) {
      await execute(
        'INSERT INTO public_suffixes (suffix, source, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
        [suffix, source],
      );
    }
    return normalized.length;
  },
};
