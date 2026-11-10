import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ listAllDomains: vi.fn(), validateCredentials: vi.fn() }));

vi.mock('../dpdns_reverse/auth', () => ({
  validateCredentials: mocks.validateCredentials,
  resolveSessionJar: (config: { sessionCookie?: string; rememberToken?: string }) => {
    const jar = new Map<string, string>();
    for (const part of (config.sessionCookie ?? '').split('; ')) {
      const i = part.indexOf('=');
      if (i > 0) jar.set(part.slice(0, i), part.slice(i + 1));
    }
    const token = jar.get('remember_token') || config.rememberToken;
    if (token) jar.set('remember_token', token);
    return jar;
  },
}));

vi.mock('../dpdns_reverse/renewal', () => ({
  listAllDomains: mocks.listAllDomains,
  parseDpdnsDate: (value: string) =>
    value.length === 8 ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)} 23:59:59` : '',
}));

import { DpdnsReverseAdapter } from '../dpdns_reverse/adapter';

const domain = (name: string) => ({ domain: name, expiry_date: '20261231' });

function adapter() {
  return new DpdnsReverseAdapter({ passkey: 'placeholder' } as never);
}

describe('DpdnsReverseAdapter.getDomainList', () => {
  beforeEach(() => {
    mocks.listAllDomains.mockReset();
  });

  it('按 page/pageSize 本地切片（上游一次返回全量、不分页）', async () => {
    mocks.listAllDomains.mockResolvedValue([
      domain('a.dpdns.org'), domain('b.dpdns.org'), domain('c.dpdns.org'),
      domain('d.dpdns.org'), domain('e.dpdns.org'),
    ]);

    const first = await adapter().getDomainList(undefined, 1, 2);
    expect(first.total).toBe(5);
    expect(first.list.map((d) => d.Domain)).toEqual(['a.dpdns.org', 'b.dpdns.org']);

    const second = await adapter().getDomainList(undefined, 2, 2);
    expect(second.total).toBe(5);
    expect(second.list.map((d) => d.Domain)).toEqual(['c.dpdns.org', 'd.dpdns.org']);
  });

  it('最后一页不足 pageSize 时按实际条数返回（同步任务据此结束翻页）', async () => {
    mocks.listAllDomains.mockResolvedValue([domain('a.dpdns.org'), domain('b.dpdns.org'), domain('c.dpdns.org')]);
    const page = await adapter().getDomainList(undefined, 2, 2);
    expect(page.list).toHaveLength(1);
    expect(page.list[0].Domain).toBe('c.dpdns.org');
  });

  it('keyword 过滤作用于全量，total 是过滤后的数量', async () => {
    mocks.listAllDomains.mockResolvedValue([domain('alpha.dpdns.org'), domain('beta.dpdns.org')]);
    const result = await adapter().getDomainList('ALPHA');
    expect(result.total).toBe(1);
    expect(result.list[0].Domain).toBe('alpha.dpdns.org');
  });

  it('越界页返回空列表但保留 total', async () => {
    mocks.listAllDomains.mockResolvedValue([domain('a.dpdns.org')]);
    const result = await adapter().getDomainList(undefined, 5, 10);
    expect(result.list).toEqual([]);
    expect(result.total).toBe(1);
  });

  it('上游失败：返回空但写入 error，不伪装成「账号下没有域名」', async () => {
    mocks.listAllDomains.mockRejectedValue(new Error('获取域名列表失败（HTTP 502）'));
    const instance = adapter();
    const result = await instance.getDomainList();
    expect(result).toEqual({ total: 0, list: [] });
    expect(instance.getError()).toContain('HTTP 502');
  });
});

describe('DpdnsReverseAdapter 的记录能力', () => {
  it('明确声明不支持记录管理（capabilities.dns = null）', async () => {
    const instance = adapter();
    const result = await instance.getDomainRecords();
    expect(result).toEqual({ total: 0, list: [] });
    expect(instance.getError()).toContain('不支持 DNS 记录管理');
  });

  it('默认线路显式返回，不是空数组', async () => {
    expect(await adapter().getRecordLines()).toEqual([{ id: '0', name: '默认' }]);
  });
});

describe('DpdnsReverseAdapter.check（升级兼容）', () => {
  beforeEach(() => {
    mocks.validateCredentials.mockReset();
  });

  it('既无通行密钥也无旧会话：直接失败，不发请求', async () => {
    const instance = new DpdnsReverseAdapter({} as never);
    expect(await instance.check()).toBe(false);
    expect(instance.getError()).toContain('未配置通行密钥');
    expect(mocks.validateCredentials).not.toHaveBeenCalled();
  });

  it('只有旧版 rememberToken 且仍有效：升级后照常可用', async () => {
    mocks.validateCredentials.mockResolvedValue(true);
    const instance = new DpdnsReverseAdapter({ rememberToken: 'legacy-token' } as never);
    expect(await instance.check()).toBe(true);
  });

  it('只有旧版 rememberToken 但已失效：提示补充通行密钥', async () => {
    mocks.validateCredentials.mockResolvedValue(false);
    const instance = new DpdnsReverseAdapter({ rememberToken: 'expired' } as never);
    expect(await instance.check()).toBe(false);
    expect(instance.getError()).toContain('请补充通行密钥');
  });

  it('有通行密钥：走换签校验', async () => {
    mocks.validateCredentials.mockResolvedValue(true);
    const instance = new DpdnsReverseAdapter({ passkey: '{}' } as never);
    expect(await instance.check()).toBe(true);
  });
});

