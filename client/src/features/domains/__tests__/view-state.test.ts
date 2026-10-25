import { describe, expect, it, beforeEach } from 'vitest';
import { readDomainsViewState, writeDomainsViewState } from '../view-state';

beforeEach(() => localStorage.clear());

describe('域名列表浏览状态', () => {
  it('写入后可读回分页与筛选', () => {
    writeDomainsViewState({ page: 2, pageSize: 10, keyword: 'example', accountId: '3', status: 'enabled' });
    expect(readDomainsViewState()).toEqual({ page: 2, pageSize: 10, keyword: 'example', accountId: '3', status: 'enabled' });
  });

  it('损坏或非法值回落默认', () => {
    localStorage.setItem('hidns.domains.view', '{broken');
    expect(readDomainsViewState().page).toBe(1);
    localStorage.setItem('hidns.domains.view', JSON.stringify({ page: -1, pageSize: 0, status: 'x' }));
    expect(readDomainsViewState()).toEqual({ page: 1, pageSize: 20, keyword: '', accountId: 'all', status: 'all' });
  });
});
