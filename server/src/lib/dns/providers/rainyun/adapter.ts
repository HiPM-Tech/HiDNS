import { createProviderAdapterLogger, DnsRecord, DomainInfo, PageResult, BaseAdapter, Dict, resolveDomainIdHelper, safeString, toNumber, fetchWithFallback } from '../internal';

const log = createProviderAdapterLogger('Rainyun');
interface RainyunConfig {
  apiKey: string;
  domain?: string;
  domainId?: string;
  useProxy?: boolean;
}

interface RainyunDomain {
  id: number;
  domain: string;
  status: string;
  created_at: string;
  expired_at: string;
}

interface RainyunRecord {
  record_id: number;
  host: string;
  type: string;
  value: string;
  ttl: number;
  line: string;
  level: number;
  rain_product_id?: number;
  rain_product_type?: string;
}

interface RainyunApiResponse<T> {
  code?: number;
  message?: string;
  data?: T;
}

interface RainyunListResponse<T> {
  TotalRecords: number;
  Records: T[];
}

export class RainyunAdapter extends BaseAdapter {
  private config: RainyunConfig;
  private baseUrl = 'https://api.v2.rainyun.com';

  constructor(config: Record<string, string>) {
    super();
    this.config = {
      apiKey: safeString(config.apiKey),
      domain: safeString(config.domain),
      domainId: safeString(config.zoneId),
      useProxy: !!config.useProxy,
    };
  }

  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey,
    };
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
    body?: Dict
  ): Promise<RainyunApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;

    const options: RequestInit = {
      method,
      headers: this.getHeaders(),
    };

    if (body && (method === 'POST' || method === 'PATCH' || method === 'DELETE')) {
      options.body = JSON.stringify(body);
    }

    const res = await fetchWithFallback(url, options, this.config.useProxy, 'Rainyun');
    const data = (await res.json()) as RainyunApiResponse<T>;

    if (!res.ok || data.code !== 200) {
      this.error = data.message || `Request failed: ${res.status}`;
    }

    return data;
  }

  async check(): Promise<boolean> {
    try {
      const res = await this.request<RainyunDomain[]>('/product/domain/', 'GET');
      return res.code === 200;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async getDomainList(keyword?: string, page = 1, pageSize = 50): Promise<PageResult<DomainInfo>> {
    try {
      const res = await this.request<RainyunListResponse<RainyunDomain>>(
        `/product/domain/?options=${encodeURIComponent(JSON.stringify({
          columnFilters: { 'domains.Domain': '' },
          sort: [] as string[],
          page,
          perPage: pageSize,
        }))}`,
        'GET'
      );

      if (res.code !== 200 || !res.data) {
        return { total: 0, list: [] };
      }

      let list = res.data.Records || [];

      if (keyword) {
        const lowerKeyword = keyword.toLowerCase();
        list = list.filter((d) => d.domain.toLowerCase().includes(lowerKeyword));
      }

      return {
        total: res.data.TotalRecords || list.length,
        list: list.map((item) => ({
          Domain: item.domain,
          ThirdId: String(item.id),
          RecordCount: undefined as number | undefined,
        })),
      };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      log.error('getDomainList failed', this.error);
      return { total: 0, list: [] };
    }
  }

  /**
   * 根据域名查找 Domain ID
   * 当 config.domainId 未设置时，尝试通过域名搜索获取
   */
  private async resolveDomainId(): Promise<string | null> {
    return resolveDomainIdHelper(this.config, this.getDomainList.bind(this), 'Rainyun');
  }

  async getDomainRecords(
    page = 1,
    pageSize = 100,
    keyword?: string,
    subdomain?: string,
    value?: string,
    type?: string,
    line?: string,
    status?: number
  ): Promise<PageResult<DnsRecord>> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        return { total: 0, list: [] };
      }

      const res = await this.request<RainyunListResponse<RainyunRecord>>(
        `/product/domain/${domainId}/dns/?limit=${pageSize}&page_no=${page}`,
        'GET'
      );

      if (res.code !== 200 || !res.data) {
        return { total: 0, list: [] };
      }

      let list = (res.data.Records || []).map((r) => this.mapRecord(r));

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

      if (line) {
        list = list.filter((r) => r.Line === line);
      }

      if (status !== undefined) {
        list = list.filter((r) => r.Status === status);
      }

      return {
        total: res.data.TotalRecords || list.length,
        list,
      };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return { total: 0, list: [] };
    }
  }

  async getDomainRecordInfo(recordId: string): Promise<DnsRecord | null> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        return null;
      }

      const res = await this.request<RainyunListResponse<RainyunRecord>>(
        `/product/domain/${domainId}/dns/`,
        'GET'
      );

      if (res.code !== 200 || !res.data) {
        return null;
      }

      const record = (res.data.Records || []).find((r) => String(r.record_id) === recordId);
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
    line?: string,
    ttl = 600,
    mx = 0,
    _weight?: number,
    _remark?: string
  ): Promise<string | null> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        return null;
      }

      const body: Dict = {
        host: name === '@' ? '' : name,
        type: type.toUpperCase(),
        value: value,
        ttl: ttl,
        line: line || 'DEFAULT',
      };

      if (type.toUpperCase() === 'MX' && mx > 0) {
        body.level = mx;
      }

      const res = await this.request<{ record_id: number }>(
        `/product/domain/${domainId}/dns`,
        'POST',
        body
      );

      if (res.code !== 200) {
        return null;
      }

      return String(res.data?.record_id ?? '');
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
    mx = 0,
    _weight?: number,
    _remark?: string
  ): Promise<boolean> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        return false;
      }

      const body: Dict = {
        record_id: toNumber(recordId, 0),
        host: name === '@' ? '' : name,
        type: type.toUpperCase(),
        value: value,
        ttl: ttl,
        line: line || 'DEFAULT',
      };

      if (type.toUpperCase() === 'MX' && mx > 0) {
        body.level = mx;
      }

      const res = await this.request<Dict>(
        `/product/domain/${domainId}/dns`,
        'PATCH',
        body
      );

      return res.code === 200;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        return false;
      }

      const res = await this.request<Dict>(
        `/product/domain/${domainId}/dns/`,
        'DELETE',
        {
          record_id: toNumber(recordId, 0),
        }
      );

      return res.code === 200;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async setDomainRecordStatus(recordId: string, status: number): Promise<boolean> {
    // 雨云 API 没有直接的启用/禁用记录功能
    this.error = 'Rainyun does not support record status toggle';
    return false;
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    // 雨云支持的线路
    return [
      { id: 'DEFAULT', name: '默认' },
      { id: 'LTEL', name: '电信' },
      { id: 'LCNC', name: '联通' },
      { id: 'LMOB', name: '移动' },
      { id: 'LEDU', name: '教育网' },
      { id: 'LSEO', name: '搜索引擎' },
      { id: 'LFOR', name: '国外' },
    ];
  }

  async getMinTTL(): Promise<number> {
    // 雨云默认最小 TTL 为 600
    return 600;
  }

  async addDomain(domain: string): Promise<boolean> {
    // 雨云 API 不支持通过 API 注册域名
    this.error = 'Rainyun does not support domain registration via API';
    return false;
  }

  private mapRecord(r: RainyunRecord): DnsRecord {
    const domain = this.config.domain || '';
    const name = r.host || '@';

    return {
      RecordId: String(r.record_id),
      Domain: domain,
      Name: name,
      Type: safeString(r.type).toUpperCase(),
      Value: safeString(r.value),
      Line: r.line || 'DEFAULT',
      TTL: r.ttl ?? 600,
      MX: r.level ?? 0,
      Status: 1, // 雨云没有记录状态字段，默认启用
    };
  }
}
