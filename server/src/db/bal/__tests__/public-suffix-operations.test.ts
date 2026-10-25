import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../business-adapter', () => ({
  execute: vi.fn(async () => undefined),
  query: vi.fn(async () => []),
}));

import { execute } from '../business-adapter';
import { PublicSuffixOperations } from '../public-suffix-operations';

const run = execute as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe('PublicSuffixOperations.replaceSource（PG 主键冲突回归）', () => {
  it('插入前按后缀删除其它 source 的同名记录，避免 23505', async () => {
    await PublicSuffixOperations.replaceSource('iana', ['AI', 'ai', 'com']);

    const sqls = run.mock.calls.map((call) => String(call[0]));
    const params = run.mock.calls.map((call) => call[1] as unknown[]);
    const conflictDelete = sqls.findIndex((sql) => sql.includes('DELETE FROM public_suffixes WHERE suffix IN'));
    const firstInsert = sqls.findIndex((sql) => sql.startsWith('INSERT INTO public_suffixes'));

    expect(conflictDelete).toBeGreaterThanOrEqual(0);
    expect(firstInsert).toBeGreaterThan(conflictDelete);
    // 去重并小写
    expect(params[conflictDelete]).toEqual(['ai', 'com']);
  });
});
