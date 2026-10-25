import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../db/bal/provider-line-operations', () => ({
  ProviderLineOperations: {
    getByProvider: vi.fn(),
    getLastUpdatedAt: vi.fn(),
    replaceForProvider: vi.fn(async () => 0),
  },
}));

import { ProviderLineOperations } from '../../db/bal/provider-line-operations';
import {
  PROVIDER_LINES_RETRY_MS,
  PROVIDER_LINES_TTL_MS,
  __resetProviderLineFailures,
  getProviderLinesCached,
  markProviderLinesFailed,
  selectProvidersToRefresh,
} from '../providerLines';

const ops = ProviderLineOperations as unknown as {
  getByProvider: ReturnType<typeof vi.fn>;
  replaceForProvider: ReturnType<typeof vi.fn>;
};

const NOW = Date.parse('2026-10-24T12:00:00Z');

function stamp(ms: number): string {
  return new Date(ms).toISOString();
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetProviderLineFailures();
});

describe('动态线路缓存', () => {
  it('缓存未过期时直接返回缓存，不请求上游', async () => {
    ops.getByProvider.mockResolvedValue([
      { provider_type: 'aliyun', line_id: '0', line_name: '默认', updated_at: stamp(NOW - 60_000) },
      { provider_type: 'aliyun', line_id: 'Dianxin', line_name: '电信', updated_at: stamp(NOW - 60_000) },
    ]);
    const fetchLines = vi.fn(async () => [{ id: 'x' }]);
    const result = await getProviderLinesCached({ providerType: 'aliyun', defaultLine: '0', fetchLines, now: NOW });
    expect(result.source).toBe('cache');
    expect(result.lines.map((line) => line.id)).toEqual(['0', 'Dianxin']);
    expect(fetchLines).not.toHaveBeenCalled();
  });

  it('缓存过期时拉取上游并写回缓存', async () => {
    ops.getByProvider.mockResolvedValue([
      { provider_type: 'aliyun', line_id: '0', line_name: '默认', updated_at: stamp(NOW - PROVIDER_LINES_TTL_MS - 1000) },
    ]);
    const fetchLines = vi.fn(async () => [{ id: '0', name: '默认' }, { id: 'Dianxin', name: '电信' }]);
    const result = await getProviderLinesCached({ providerType: 'aliyun', defaultLine: '0', fetchLines, now: NOW });
    expect(result.source).toBe('live');
    expect(ops.replaceForProvider).toHaveBeenCalledWith('aliyun', expect.arrayContaining([{ id: 'Dianxin', name: '电信' }]));
  });

  it('拉取失败只返回默认线路，并在 5 分钟内不再重试', async () => {
    ops.getByProvider.mockResolvedValue([]);
    const fetchLines = vi.fn(async () => { throw new Error('upstream 500'); });
    const first = await getProviderLinesCached({ providerType: 'huawei', defaultLine: 'default_view', fetchLines, now: NOW });
    expect(first).toEqual({ lines: [{ id: 'default_view', name: '默认' }], source: 'default' });
    expect(fetchLines).toHaveBeenCalledTimes(1);

    const second = await getProviderLinesCached({
      providerType: 'huawei', defaultLine: 'default_view', fetchLines, now: NOW + PROVIDER_LINES_RETRY_MS - 1000,
    });
    expect(second.source).toBe('default');
    expect(fetchLines).toHaveBeenCalledTimes(1);

    const third = await getProviderLinesCached({
      providerType: 'huawei', defaultLine: 'default_view', fetchLines, now: NOW + PROVIDER_LINES_RETRY_MS + 1000,
    });
    expect(third.source).toBe('default');
    expect(fetchLines).toHaveBeenCalledTimes(2);
  });

  it('上游返回空列表也视为失败（只给默认线路）', async () => {
    ops.getByProvider.mockResolvedValue([]);
    const fetchLines = vi.fn(async () => []);
    const result = await getProviderLinesCached({ providerType: 'dnsneko', defaultLine: 'default', fetchLines, now: NOW });
    expect(result).toEqual({ lines: [{ id: 'default', name: '默认' }], source: 'default' });
    expect(ops.replaceForProvider).not.toHaveBeenCalled();
  });
});

describe('任务筛选', () => {
  it('只为有启用账号的提供商拉取，并跳过新鲜缓存与失败冷却', () => {
    markProviderLinesFailed('huawei', NOW - 1000);
    const targets = selectProvidersToRefresh({
      now: NOW,
      accounts: [
        { type: 'aliyun', enabled: 1 },
        { type: 'aliyun', enabled: 1 },
        { type: 'dnspod', enabled: 0 },
        { type: 'huawei', enabled: 1 },
        { type: 'baidu', enabled: true },
      ],
      cacheUpdatedAt: new Map<string, string | null>([
        ['aliyun', stamp(NOW - PROVIDER_LINES_TTL_MS - 1000)],
        ['huawei', null],
        ['baidu', stamp(NOW - 60_000)],
      ]),
    });
    // aliyun 过期 → 拉；dnspod 禁用 → 不拉；huawei 冷却中 → 不拉；baidu 新鲜 → 不拉
    expect(targets).toEqual(['aliyun']);
  });
});
