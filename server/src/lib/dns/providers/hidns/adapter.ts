import { createProviderAdapterLogger, DnsAdapter, DnsRecord, DomainInfo, PageResult, fetchWithFallback, resolveDomainIdHelper } from '../internal';
export const DEFAULT_LINE = '0';

const log = createProviderAdapterLogger('HiDNS');
interface HiDNSConfig {
  baseUrl: string;
  apiToken: string;
  domain?: string;
  domainId?: string;
  useProxy?: boolean;
}

interface HiDNSApiResponse<T> {
  code: number;
  data: T;
  msg: string;
}

interface HiDNSDomain {
  id: number;
  name: string;
  account_id: number;
  third_id: string;
  record_count: number;
}

interface HiDNSRecord {
  id: string;
  name: string;
  type: string;
  value: string;
  line: string;
  ttl: number;
  mx: number;
  weight: number;
  status: number;
  remark: string | null;
  updated_at: string | null;
  proxiable: boolean | null;
  cloudflare: {
    proxied: boolean;
    proxiable: boolean;
  } | null;
}

export class HiDNSAdapter implements DnsAdapter {
  private config: HiDNSConfig;
  private error: string = '';

  constructor(config: Record<string, string>) {
    this.config = {
      baseUrl: config.baseUrl || '',
      apiToken: config.apiToken || '',
      domain: config.domain,
      domainId: config.domainId,
      useProxy: !!config.useProxy,
    };
  }

  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiToken}`,
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<HiDNSApiResponse<T>> {
    // Ensure baseUrl doesn't end with /api and path starts with /
    const baseUrl = this.config.baseUrl.replace(/\/api\/?$/, '');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${baseUrl}/api${normalizedPath}`;
    log.sub('API').tag('REQUEST').debug('Provider request', { method: method, url: url, params: body });

    try {
      const res = await fetchWithFallback(url, {
        method,
        headers: this.getHeaders(),
        body: body ? JSON.stringify(body) : undefined,
      }, this.config.useProxy, 'HiDNS');

      const data = (await res.json()) as HiDNSApiResponse<T>;
      log.sub('API').tag('RESPONSE').debug('Provider response', { status: res.status, success: data.code === 0, data: { resultCount: data.data && typeof data.data === 'object' && 'list' in data.data ? (data.data as any).list?.length : 0 } });

      if (data.code !== 0) {
        this.error = data.msg || 'API error';
        log.sub('API').tag('ERROR').error('Provider error', [{ message: this.error }]);
      }

      return data;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      log.sub('API').tag('ERROR').error('Provider error', [{ message: this.error }]);
      return { code: -1, data: {} as T, msg: this.error };
    }
  }

  async check(): Promise<boolean> {
    try {
      // 尝试获取域名列表来验证连接
      const res = await this.request<{ total: number; list: HiDNSDomain[] }>('GET', '/domains?page=1&pageSize=1');
      return res.code === 0;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  getError(): string {
    return this.error;
  }

  async getDomainList(keyword?: string, page = 1, pageSize = 50): Promise<PageResult<DomainInfo>> {
    try {
      let path = `/domains?page=${page}&pageSize=${pageSize}`;
      if (keyword) {
        path += `&keyword=${encodeURIComponent(keyword)}`;
      }

      // HiDNS API can return either { total, list } or direct array
      const res = await this.request<any>('GET', path);

      log.debug('getDomainList response', {
        code: res.code,
        hasData: !!res.data,
        dataType: typeof res.data,
        isObject: typeof res.data === 'object' && !Array.isArray(res.data),
        isArray: Array.isArray(res.data),
        hasList: res.data && typeof res.data === 'object' && 'list' in res.data,
        dataLength: Array.isArray(res.data) ? res.data.length : (res.data?.list?.length || 0),
        rawData: JSON.stringify(res.data).substring(0, 200)
      });

      if (res.code !== 0) {
        this.error = `读取域名列表失败：code=${res.code}`;
        log.error('getDomainList failed', { code: res.code, msg: res.msg });
        return { total: 0, list: [] };
      }

      let domains: HiDNSDomain[];
      let total: number;

      // Smart detection: support both array and object formats
      if (Array.isArray(res.data)) {
        // Format 1: Direct array (when using API Token or format=array)
        domains = res.data;
        total = domains.length;
        log.debug('Detected array format response');
      } else if (res.data && typeof res.data === 'object' && 'list' in res.data) {
        // Format 2: Paginated object { total, list, page, pageSize }
        domains = res.data.list;
        total = res.data.total || domains.length;
        log.debug('Detected paginated object format response');
      } else {
        this.error = '读取域名列表失败：返回结构不合法';
        log.error('getDomainList invalid data structure', { data: res.data });
        return { total: 0, list: [] };
      }

      // Apply keyword filter if provided (server-side filtering may not work)
      let filteredDomains = domains;
      if (keyword) {
        const lowerKeyword = keyword.toLowerCase();
        filteredDomains = domains.filter((d: HiDNSDomain) => d.name.toLowerCase().includes(lowerKeyword));
      }

      return {
        total: filteredDomains.length,
        list: filteredDomains.map((d: HiDNSDomain) => ({
          Domain: d.name,
          ThirdId: String(d.id),
          RecordCount: d.record_count || 0,
        })),
      };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      log.error('getDomainList exception', { error: this.error });
      return { total: 0, list: [] };
    }
  }

  /**
   * 根据域名查找 Domain ID
   * 当 config.domainId 未设置时，尝试通过域名搜索获取
   */
  private async resolveDomainId(): Promise<string | null> {
    return resolveDomainIdHelper(this.config, this.getDomainList.bind(this), 'HiDNS');
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
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        this.error = 'Domain ID not set';
        return { total: 0, list: [] };
      }

      let path = `/domains/${domainId}/records?page=${page}&pageSize=${pageSize}`;
      if (keyword) path += `&keyword=${encodeURIComponent(keyword)}`;
      if (subdomain) path += `&subdomain=${encodeURIComponent(subdomain)}`;
      if (value) path += `&value=${encodeURIComponent(value)}`;
      if (type) path += `&type=${encodeURIComponent(type)}`;
      if (status !== undefined) path += `&status=${status}`;

      const res = await this.request<{ total: number; list: HiDNSRecord[] }>('GET', path);

      if (res.code !== 0) {
        this.error = this.error || '读取记录失败：未解析到域名或上游返回空结果';
      return { total: 0, list: [] };
      }

      return {
        total: res.data.total,
        list: res.data.list.map((r) => this.mapRecord(r)),
      };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return { total: 0, list: [] };
    }
  }

  private mapRecord(r: HiDNSRecord): DnsRecord {
    return {
      RecordId: String(r.id),
      Domain: this.config.domain || '',
      Name: r.name,
      Type: r.type,
      Value: r.value,
      Line: r.line,
      TTL: r.ttl,
      MX: r.mx,
      Status: r.status,
      Weight: r.weight,
      Remark: r.remark || undefined,
      UpdateTime: r.updated_at || undefined,
      Proxiable: r.proxiable ?? undefined,
      Cloudflare: r.cloudflare || undefined,
    };
  }

  async getDomainRecordInfo(recordId: string): Promise<DnsRecord | null> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        this.error = 'Domain ID not set';
        return null;
      }

      // HiDNS API 没有单独的获取单条记录接口，从列表中查找
      const res = await this.request<{ total: number; list: HiDNSRecord[] }>('GET', `/domains/${domainId}/records?page=1&pageSize=1000`);

      if (res.code !== 0) {
        return null;
      }

      const record = res.data.list.find((r) => r.id === recordId);
      return record ? this.mapRecord(record) : null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  async addDomainRecord(
    name: string,
    type: string,
    value: string,
    line?: string,
    ttl = 600,
    mx = 1,
    weight?: number,
    remark?: string
  ): Promise<string | null> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        this.error = 'Domain ID not set';
        return null;
      }

      const body: Record<string, unknown> = {
        name,
        type,
        value,
        ttl,
      };
      if (line) body.line = line;
      if (type === 'MX') body.mx = mx;
      if (weight !== undefined) body.weight = weight;
      if (remark) body.remark = remark;

      const res = await this.request<{ id: string }>('POST', `/domains/${domainId}/records`, body);

      if (res.code !== 0) {
        return null;
      }

      return res.data.id;
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
    line?: string,
    ttl = 600,
    mx = 1,
    weight?: number,
    remark?: string
  ): Promise<boolean> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        this.error = 'Domain ID not set';
        return false;
      }

      const body: Record<string, unknown> = {
        name,
        type,
        value,
        ttl,
      };
      if (line) body.line = line;
      if (type === 'MX') body.mx = mx;
      if (weight !== undefined) body.weight = weight;
      if (remark) body.remark = remark;

      const res = await this.request<null>('PUT', `/domains/${domainId}/records/${recordId}`, body);
      return res.code === 0;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        this.error = 'Domain ID not set';
        return false;
      }

      const res = await this.request<null>('DELETE', `/domains/${domainId}/records/${recordId}`);
      return res.code === 0;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async setDomainRecordStatus(recordId: string, status: number): Promise<boolean> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        this.error = 'Domain ID not set';
        return false;
      }

      const res = await this.request<null>('PUT', `/domains/${domainId}/records/${recordId}/status`, { status });
      return res.code === 0;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    // HiDNS 默认线路
    return [
      { id: '0', name: '默认' },
    ];
  }

  async getMinTTL(): Promise<number> {
    return 60;
  }

  async addDomain(domain: string): Promise<boolean> {
    // HiDNS 作为提供商，不支持通过 API 添加域名到对方系统
    this.error = 'Adding domains is not supported for HiDNS provider';
    return false;
  }
}
