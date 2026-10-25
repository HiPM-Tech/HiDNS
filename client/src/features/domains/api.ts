import { http } from '../../lib/http';

export interface DomainRow {
  id: number;
  name: string;
  account_id: number;
  third_id?: string;
  remark?: string;
  enabled?: number | boolean;
  record_count?: number;
  expires_at?: string;
  apex_expires_at?: string;
  whois_status?: string;
  created_at?: string;
  /** 服务端按 resolveDomainAccess 算出的写权限；undefined 视为可写（兼容旧缓存） */
  can_write?: boolean;
  /** grouped=true 时，子域行带上所属虚拟组的负 id */
  _groupParentId?: number;
}

export interface DomainAccount {
  id: number;
  name: string;
  type: string;
  enabled?: boolean | number;
}

/** 虚拟分组行：后端 grouped=true 时插入，id 为负值（-父域 id） */
export interface DomainGroupHeader {
  _type: 'group_header';
  id: number;
  groupName: string;
  childIds: number[];
  /** false = 虚拟组：父域本身没有添加进系统 */
  parentPresent?: boolean;
}

export type DomainListItem = DomainRow | DomainGroupHeader;

export function isGroupHeader(item: DomainListItem): item is DomainGroupHeader {
  return (item as DomainGroupHeader)._type === 'group_header';
}

export interface DomainListResult {
  list: DomainListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface DomainQuery {
  page: number;
  pageSize: number;
  keyword?: string;
  account_id?: number;
  domain_status?: 'enabled' | 'disabled' | 'all';
  domain_type?: 'apex' | 'subdomain' | 'all';
  /** 置顶域名 id（逗号分隔），服务端据此把置顶项排在前面 */
  pinned_domains?: string;
  /** 按可注册域虚拟分组（组头行由服务端生成） */
  grouped?: boolean;
  /** 无条件造组：父域未添加也虚拟出组头（用户开关） */
  virtual_groups?: boolean;
}

export async function listDomains(query: DomainQuery): Promise<DomainListResult> {
  const envelope = await http.get<Partial<DomainListResult>>('/domains', {
    query: {
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword || undefined,
      account_id: query.account_id,
      domain_status: query.domain_status && query.domain_status !== 'all' ? query.domain_status : undefined,
      domain_type: query.domain_type && query.domain_type !== 'all' ? query.domain_type : undefined,
      pinned_domains: query.pinned_domains || undefined,
      grouped: query.grouped ? 'true' : undefined,
      virtual_groups: query.virtual_groups ? 'true' : undefined,
    },
  });
  const data = envelope.data ?? {};
  const list = (data.list ?? []) as DomainListItem[];
  return {
    list,
    total: data.total ?? list.length,
    page: data.page ?? query.page,
    pageSize: data.pageSize ?? query.pageSize,
    totalPages: data.totalPages ?? Math.max(1, Math.ceil((data.total ?? list.length) / query.pageSize)),
  };
}

export async function listDomainAccounts(): Promise<DomainAccount[]> {
  const envelope = await http.get<DomainAccount[] | { list?: DomainAccount[] }>('/accounts');
  const data = envelope.data;
  return Array.isArray(data) ? data : (data?.list ?? []);
}

export interface ProviderDomainOption {
  name: string;
  third_id?: string;
  expires_at?: string | null;
}

export async function listProviderDomains(accountId: number): Promise<ProviderDomainOption[]> {
  const envelope = await http.get<ProviderDomainOption[] | { list?: ProviderDomainOption[] }>(`/domains/provider-list/${accountId}`);
  const data = envelope.data;
  return Array.isArray(data) ? data : (data?.list ?? []);
}

export async function addDomains(accountId: number, domains: ProviderDomainOption[]): Promise<{ added?: number; skipped?: number; duplicates?: string[] }> {
  const envelope = await http.postOk<{ added?: number; skipped?: number; duplicates?: string[] }>('/domains', {
    account_id: accountId,
    domains,
  });
  if (envelope.code !== 0) throw new Error(envelope.msg || '添加失败');
  return envelope.data ?? {};
}

export function updateDomain(id: number, body: { enabled?: number; remark?: string }) {
  return http.putOk<null>(`/domains/${id}`, body);
}

export function deleteDomain(id: number) {
  return http.deleteOk<null>(`/domains/${id}`);
}

export function isDomainEnabled(domain: DomainRow): boolean {
  return domain.enabled === undefined || domain.enabled === null ? true : Boolean(Number(domain.enabled) || domain.enabled === true);
}
