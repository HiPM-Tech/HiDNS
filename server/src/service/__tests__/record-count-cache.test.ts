import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/dns/DnsHelper', () => ({ createAdapter: vi.fn() }));
vi.mock('../../db/bal/business-adapter', () => ({
  DomainOperations: { getAll: vi.fn(), updateRecordCount: vi.fn() },
  DnsAccountOperations: { getById: vi.fn() },
}));

import { createAdapter } from '../../lib/dns/DnsHelper';
import { DomainOperations, DnsAccountOperations } from '../../db/bal/business-adapter';
import { refreshAllDomainRecordCounts } from '../recordCountCache';

const domains = [
  { id: 1, account_id: 1, name: 'a.test', third_id: 'z1', record_count: 5 },
  { id: 2, account_id: 1, name: 'b.test', third_id: 'z2', record_count: 7 },
];

function adapterWith(total: number, error = '') {
  return {
    clearError: vi.fn(),
    getError: vi.fn(() => error),
    getDomainRecords: vi.fn(async () => ({ total, list: total > 0 ? [{ RecordId: 'r1' }] : [] })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(DomainOperations.getAll).mockResolvedValue(domains as never);
  vi.mocked(DnsAccountOperations.getById).mockResolvedValue({ id: 1, type: 'virtual', config: '{}' } as never);
});

describe('record_count 缓存（P0-4）', () => {
  it('成功读到 0 条也会回写（旧值不会永不过期）', async () => {
    vi.mocked(createAdapter).mockReturnValue(adapterWith(0) as never);
    await refreshAllDomainRecordCounts();
    expect(DomainOperations.updateRecordCount).toHaveBeenCalledWith(1, 0);
  });

  it('空结果 + 适配器错误 → 视为失败，不覆盖旧计数', async () => {
    vi.mocked(createAdapter).mockReturnValue(adapterWith(0, 'upstream 500') as never);
    await refreshAllDomainRecordCounts();
    expect(DomainOperations.updateRecordCount).not.toHaveBeenCalled();
  });

  it('正常总数照常回写', async () => {
    vi.mocked(createAdapter).mockReturnValue(adapterWith(9) as never);
    await refreshAllDomainRecordCounts();
    expect(DomainOperations.updateRecordCount).toHaveBeenCalledWith(1, 9);
  });
});
