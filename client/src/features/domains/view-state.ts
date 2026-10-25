export interface DomainsViewState {
  page: number;
  pageSize: number;
  keyword: string;
  accountId: string;
  status: 'all' | 'enabled' | 'disabled';
}

const KEY = 'hidns.domains.view';
const DEFAULT_STATE: DomainsViewState = { page: 1, pageSize: 20, keyword: '', accountId: 'all', status: 'all' };

/** 读取域名列表上次的浏览状态（分页/筛选）；进入记录页再返回、刷新或重新打开页面都可恢复 */
export function readDomainsViewState(): DomainsViewState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<DomainsViewState>;
    const page = Number(parsed.page);
    const pageSize = Number(parsed.pageSize);
    const status = parsed.status;
    return {
      page: Number.isInteger(page) && page > 0 ? page : DEFAULT_STATE.page,
      pageSize: Number.isInteger(pageSize) && pageSize > 0 ? pageSize : DEFAULT_STATE.pageSize,
      keyword: typeof parsed.keyword === 'string' ? parsed.keyword : '',
      accountId: typeof parsed.accountId === 'string' && parsed.accountId ? parsed.accountId : 'all',
      status: status === 'enabled' || status === 'disabled' ? status : 'all',
    };
  } catch {
    return DEFAULT_STATE;
  }
}

export function writeDomainsViewState(state: DomainsViewState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // 隐私模式等场景下 localStorage 不可用：不影响列表本身
  }
}
