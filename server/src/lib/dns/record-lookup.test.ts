import { describe, it, expect, vi } from 'vitest';
import { findRecordMeta } from './record-lookup';

function adapter(overrides: Record<string, unknown> = {}) {
  return {
    getDomainRecordInfo: vi.fn(async () => null),
    getDomainRecords: vi.fn(async () => ({ total: 0, list: [] })),
    ...overrides,
  } as never;
}

describe('记录元数据读取', () => {
  it('单条查询成功直接返回', async () => {
    const a = adapter({ getDomainRecordInfo: vi.fn(async () => ({ RecordId: 'r1', Type: 'A' })) });
    const meta = await findRecordMeta(a, 'r1');
    expect(meta?.RecordId).toBe('r1');
  });

  it('单条查询抛错时降级到列表查找', async () => {
    const a = adapter({
      getDomainRecordInfo: vi.fn(async () => {
        throw new Error('unsupported');
      }),
      getDomainRecords: vi.fn(async () => ({ total: 1, list: [{ RecordId: 'r1', Type: 'A', Value: '1.1.1.1' }] })),
    });
    const meta = await findRecordMeta(a, 'r1');
    expect(meta?.Value).toBe('1.1.1.1');
  });

  it('两条路径都失败返回 null', async () => {
    const a = adapter({
      getDomainRecordInfo: vi.fn(async () => {
        throw new Error('x');
      }),
      getDomainRecords: vi.fn(async () => {
        throw new Error('y');
      }),
    });
    await expect(findRecordMeta(a, 'r1')).resolves.toBeNull();
  });
});