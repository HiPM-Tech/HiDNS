import { describe, expect, it } from 'vitest';
import { MAX_BATCH_RECORDS, assertBatchSize } from '../records';

/** 批量导入上限：docs/api.md 承诺「单次最多 100 条，超出 422」 */
describe('批量导入上限', () => {
  it('上限为 100 条', () => {
    expect(MAX_BATCH_RECORDS).toBe(100);
  });

  it('空数组与超限分别给出 400 / 422 的文案', () => {
    expect(assertBatchSize(0)).toBe('records array is required');
    expect(assertBatchSize(1)).toBeNull();
    expect(assertBatchSize(MAX_BATCH_RECORDS)).toBeNull();
    expect(assertBatchSize(MAX_BATCH_RECORDS + 1)).toContain('At most');
  });
});
