import { createProviderAdapterLogger, DnsAdapter, DnsRecord, DomainInfo, PageResult, asArray, Dict, normalizeRrName, safeString, BaseAdapter, toNumber, toRecordStatus, fetchWithFallback, requireNumericRecordId } from '../internal';
import { renewSubdomain as renewSubdomainApi } from './renewal';
import { getWhois as getWhoisApi } from './whois';

const log = createProviderAdapterLogger('DNSHE');
interface DnsheConfig {
  apiKey: string;
  apiSecret: string;
  domain?: string;
  subdomainId?: string;
  useProxy?: boolean;
}

interface DnsheSubdomain {
  id: number;
  subdomain: string;
  rootdomain: string;
  full_domain: string;
  status: string;
  created_at: string;
  updated_at: string;
  expires_at?: string;  // Added in V2.0
  never_expires?: number;  // Added in V2.0
}

interface DnsheRecord {
  id: number;
  record_id?: string;  // Cloud provider record ID (V2.0)
  name: string;
  type: string;
  content: string;
  ttl: number;
  priority: number | null;
  line?: string | null;  // Added in V2.0
  proxied: boolean;
  status: string;
  created_at: string;
  updated_at?: string;  // Added in V2.0
  subdomain?: string;  // Subdomain name
  rootdomain?: string;  // Root domain
  full_domain?: string;  // Full domain name
}

interface DnsheApiResponse<T> {
  success: boolean;
  message?: string;
  error?: string;
  count?: number;
  subdomains?: DnsheSubdomain[];
  subdomain?: DnsheSubdomain;
  dns_records?: DnsheRecord[];
  records?: DnsheRecord[];
  record_id?: number;
  // V2.0: Pagination info
  pagination?: {
    page: number;
    per_page: number;
    has_more: boolean;
    next_page?: number;
    prev_page?: number;
    total?: number;
  };
}

export class DnsheAdapter extends BaseAdapter implements DnsAdapter {
  private config: DnsheConfig;
  private baseUrl = 'https://api005.dnshe.com/index.php';

  constructor(config: Record<string, string>) {
    super();
    this.config = {
      apiKey: safeString(config.apiKey),
      apiSecret: safeString(config.apiSecret),
      domain: safeString(config.domain),
      subdomainId: safeString(config.zoneId),
      useProxy: !!config.useProxy,
    };
  }

  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-API-Key': this.config.apiKey,
      'X-API-Secret': this.config.apiSecret,
    };
  }

  private async request<T>(
    endpoint: string,
    action: string,
    method: 'GET' | 'POST' = 'GET',
    body?: Dict,
    queryParams?: Record<string, string | number>
  ): Promise<DnsheApiResponse<T>> {
    let url = `${this.baseUrl}?m=domain_hub&endpoint=${endpoint}&action=${action}`;

    // Add query parameters for GET requests
    if (queryParams && method === 'GET') {
      const params = new URLSearchParams();
      Object.entries(queryParams).forEach(([key, value]) => {
        params.append(key, String(value));
      });
      url += `&${params.toString()}`;
    }

    const options: RequestInit = {
      method,
      headers: this.getHeaders(),
    };

    if (method === 'POST' && body) {
      options.body = JSON.stringify(body);
    }

    const res = await fetchWithFallback(url, options, this.config.useProxy, 'DNSHE');
    const data = (await res.json()) as DnsheApiResponse<T>;

    if (!data.success) {
      this.error = data.error || data.message || 'Unknown error';
      log.error(`Request failed: ${endpoint}/${action}`, { error: this.error });
    }

    return data;
  }

  async check(): Promise<boolean> {
    try {
      const res = await this.request<DnsheSubdomain[]>('subdomains', 'list', 'GET');
      return res.success;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async getDomainList(keyword?: string, page = 1, pageSize = 50): Promise<PageResult<DomainInfo>> {
    try {
      // Use API pagination with include_total for accurate count
      const res = await this.request<any>('subdomains', 'list', 'GET', undefined, {
        page,
        per_page: Math.min(pageSize, 500), // Max 500 per API docs
        include_total: 1,
        ...(keyword && { search: keyword }),
      });

      if (!res.success || !res.subdomains) {
        return { total: 0, list: [] };
      }

      const list = res.subdomains.map((item: DnsheSubdomain) => ({
        Domain: item.full_domain,  // Use full_domain from DNSHE API directly
        ThirdId: String(item.id),
        RecordCount: undefined as number | undefined,
        // V2.0: Include expiry information if available
        ExpiresAt: item.expires_at,
        NeverExpires: item.never_expires === 1,
      }));

      // API returns paginated results, use the total from response
      const total = res.pagination?.total ?? list.length;

      return { total, list };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      log.error('getDomainList failed', this.error);
      return { total: 0, list: [] };
    }
  }

  async getDomainRecords(
    page = 1,
    pageSize = 100,
    keyword?: string,
    subdomain?: string,
    value?: string,
    type?: string,
    _line?: string,
    status?: number
  ): Promise<PageResult<DnsRecord>> {
    try {
      if (!this.config.subdomainId) {
        this.error = 'Subdomain ID not configured';
        log.error('getDomainRecords failed: subdomainId not set');
        return { total: 0, list: [] };
      }

      // Pass subdomain_id as query parameter
      const res = await this.request<DnsheRecord[]>(
        'dns_records',
        'list',
        'GET',
        undefined,
        { subdomain_id: toNumber(this.config.subdomainId, 0) }
      );

      if (!res.success || !res.records) {
        log.error('getDomainRecords failed: API returned no records', { success: res.success });
        this.error = this.error || '读取记录失败：未解析到域名或上游返回空结果';
      return { total: 0, list: [] };
      }

      let list = res.records.map((r) => this.mapRecord(r));

      if (keyword) {
        const lowerKeyword = keyword.toLowerCase();
        list = list.filter((r) =>
          r.Name.toLowerCase().includes(lowerKeyword) ||
          r.Value.toLowerCase().includes(lowerKeyword)
        );
      }

      if (subdomain) {
        list = list.filter((r) => r.Name.toLowerCase() === subdomain.toLowerCase());
      }

      if (value) {
        list = list.filter((r) => r.Value.toLowerCase().includes(value.toLowerCase()));
      }

      if (type) {
        list = list.filter((r) => r.Type.toUpperCase() === type.toUpperCase());
      }

      if (status !== undefined) {
        list = list.filter((r) => r.Status === status);
      }

      const total = list.length;
      const offset = (page - 1) * pageSize;
      list = list.slice(offset, offset + pageSize);

      log.info('getDomainRecords success', { total, page, pageSize });
      return { total, list };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      log.error('getDomainRecords exception', { error: this.error });
      return { total: 0, list: [] };
    }
  }

  async getDomainRecordInfo(recordId: string): Promise<DnsRecord | null> {
    try {
      if (!this.config.subdomainId) {
        this.error = 'Subdomain ID not configured';
        return null;
      }

      // Get all records and find the specific one
      const res = await this.request<DnsheRecord[]>(
        'dns_records',
        'list',
        'GET',
        undefined,
        { subdomain_id: toNumber(this.config.subdomainId, 0) }
      );

      if (!res.success || !res.records) {
        return null;
      }

      const record = res.records.find((r) => String(r.id) === recordId);
      if (!record) {
        return null;
      }

      return this.mapRecord(record);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  async addDomainRecord(
    name: string,
    type: string,
    value: string,
    _line?: string,
    ttl = 120,
    mx = 0,
    _weight?: number,
    _remark?: string
  ): Promise<string | null> {
    try {
      if (!this.config.subdomainId) {
        return null;
      }

      const body: Dict = {
        subdomain_id: toNumber(this.config.subdomainId, 0),
        type: type.toUpperCase(),
        content: value,
        ttl,
      };

      // DNSHE 支持根域 CNAME，name 为 @ 或不传都表示根域
      if (name && name !== '@') {
        body.name = name;
      }
      // 如果 name 是 '@'，不传 name 字段，API 会默认为根域

      if (type.toUpperCase() === 'MX' && mx > 0) {
        body.priority = mx;
      }

      const res = await this.request<{ record_id: number }>('dns_records', 'create', 'POST', body);
      log.info('Add record response', {
        success: res.success,
        record_id: res.record_id,
        fullResponse: JSON.stringify(res)
      });
      if (!res.success) {
        log.error('Add record failed', { response: res });
        return null;
      }

      const recordId = res.record_id;
      if (!recordId) {
        log.error('No record_id in response', { response: res });
        return null;
      }

      return String(recordId);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  async updateDomainRecord(
    recordId: string,
    name: string,
    type: string,
    value: string,
    _line?: string,
    ttl = 120,
    mx = 0,
    _weight?: number,
    _remark?: string
  ): Promise<boolean> {
    try {
      const body: Dict = {
        record_id: requireNumericRecordId(recordId),
        content: value,
        ttl,
      };

      if (name && name !== '@') {
        body.name = name;
      }

      if (type.toUpperCase() === 'MX' && mx > 0) {
        body.priority = mx;
      }

      const res = await this.request<Dict>('dns_records', 'update', 'POST', body);
      return res.success;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    try {
      const res = await this.request<Dict>('dns_records', 'delete', 'POST', {
        record_id: requireNumericRecordId(recordId),
      });
      return res.success;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async setDomainRecordStatus(recordId: string, status: number): Promise<boolean> {
    // DNSHE API 没有直接的启用/禁用记录功能
    // 通过更新记录状态来模拟（如果 API 支持）
    // 这里返回 true 表示操作成功，但实际上 DNSHE 可能不支持此功能
    this.error = 'DNSHE does not support record status toggle';
    return false;
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    // DNSHE 不支持线路选择，返回默认线路
    return [{ id: '0', name: '默认' }];
  }

  async getMinTTL(): Promise<number> {
    // DNSHE 默认最小 TTL 为 120
    return 120;
  }

  async addDomain(domain: string): Promise<boolean> {
    try {
      // 解析域名获取 subdomain 和 rootdomain
      const parts = domain.split('.');
      if (parts.length < 2) {
        this.error = 'Invalid domain format';
        return false;
      }

      const subdomain = parts[0];
      const rootdomain = parts.slice(1).join('.');

      const res = await this.request<DnsheSubdomain>('subdomains', 'register', 'POST', {
        subdomain,
        rootdomain,
      });

      return res.success;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  /**
   * Renew a subdomain (using modular renewal function)
   */
  async renewSubdomain(subdomainId: number): Promise<any> {
    return renewSubdomainApi(
      {
        apiKey: this.config.apiKey,
        apiSecret: this.config.apiSecret,
        useProxy: this.config.useProxy,
      },
      subdomainId
    );
  }

  /**
   * Get WHOIS information for a domain (using modular whois function)
   */
  async getWhois(domain: string): Promise<any> {
    return getWhoisApi(
      {
        apiKey: this.config.apiKey,
        apiSecret: this.config.apiSecret,
        useProxy: this.config.useProxy,
      },
      domain
    );
  }

  private mapRecord(r: DnsheRecord): DnsRecord {
    // Use full_domain from DNSHE API directly
    const domain = r.full_domain || this.config.domain || '';

    // Extract record name from full domain
    let name: string;
    if (r.name === '@' || r.name === domain) {
      name = '@';
    } else if (domain && r.name.endsWith(`.${domain}`)) {
      name = r.name.slice(0, -domain.length - 1);
    } else {
      name = r.name || '@';
    }

    return {
      RecordId: String(r.id),
      Domain: domain,
      Name: name,
      Type: safeString(r.type).toUpperCase(),
      Value: safeString(r.content),
      Line: 'default',
      TTL: r.ttl ?? 120,
      MX: r.priority ?? 0,
      Status: r.status === 'active' ? 1 : 0,
      UpdateTime: r.created_at,
    };
  }
}
