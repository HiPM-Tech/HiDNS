import { createProviderAdapterLogger, DnsAdapter, DnsRecord, DomainInfo, PageResult, normalizeRrName, safeString, toNumber, resolveDomainIdHelper, Dict, resolveProviderLine } from '../internal';
import { buildAuthHeaders, authenticatedRequest, type DnsnekoAuthConfig } from './auth';

const log = createProviderAdapterLogger('Dnsneko');

interface DnsnekoConfig extends DnsnekoAuthConfig {
  domain?: string;
  domainId?: string;
  zoneId?: string;
}

interface DnsnekoApiResponse<T> {
  code: number;
  errorCode?: string | null;
  message?: string;
  data?: T;
}

interface DnsnekoDomain {
  id: string;
  domain: string;
  domainType: string;
  nsStatus?: number | null;
  status: number;
  expired?: boolean;
  expireTime?: string;
  recordCount?: string;
}

interface DnsnekoRecord {
  id: string;
  domainId?: string | null;
  name: string;
  type: string;
  recordSet?: boolean;
  loadBalance?: string | null;
  healthCheckEnabled?: boolean;
  healthCheckPort?: number | null;
  value: string;
  line: string;
  ttl: number;
  priority?: number | null;
  remark?: string;
  status: number;
  updateTime?: string | null;
}

export class DnsnekoAdapter implements DnsAdapter {
  private config: DnsnekoConfig;
  private baseUrl = 'https://www.dnsneko.com/api/v1/dns';
  private error: string = '';

  constructor(config: Record<string, string>) {
    this.config = {
      username: safeString(config.username || ''),
      apiKey: safeString(config.apiKey || ''),
      domain: safeString(config.domain),
      domainId: safeString(config.domainId),
      zoneId: safeString(config.zoneId),
      useProxy: !!config.useProxy,
    };
  }

  getError(): string {
    return this.error;
  }

  /**
   * Parse composite third_id format: "{domainType}:{domainId}"
   * Backward compatible: plain numeric string defaults to internal.
   */
  private parseDomainRef(): { domainId: string; domainType: string } {
    const ref = this.config.zoneId || this.config.domainId || '';
    if (ref.includes(':')) {
      const [domainType, domainId] = ref.split(':', 2);
      return { domainId: domainId || '', domainType: domainType || 'internal' };
    }
    return { domainId: ref, domainType: 'internal' };
  }

  private async resolveDomainId(): Promise<string | null> {
    const parsed = this.parseDomainRef();
    if (parsed.domainId) return parsed.domainId;

    const id = await resolveDomainIdHelper(this.config, this.getDomainList.bind(this), 'Dnsneko');
    if (!id) return null;

    // resolveDomainIdHelper may have cached a composite third_id from getDomainList
    return id.includes(':') ? id.split(':', 2)[1] : id;
  }

  private async request<T>(
    method: string,
    path: string,
    params?: Dict,
    queryParams?: Dict,
  ): Promise<DnsnekoApiResponse<T>> {
    let url = `${this.baseUrl}${path}`;
    let body: string | undefined;

    const allQueryParams: Dict = {};
    if (method === 'GET' && params) {
      Object.assign(allQueryParams, params);
    } else if (params) {
      body = JSON.stringify(params);
    }
    if (queryParams) {
      Object.assign(allQueryParams, queryParams);
    }

    const entries = Object.entries(allQueryParams).filter(([_, v]) => v !== undefined && v !== null);
    if (entries.length > 0) {
      const query = new URLSearchParams();
      for (const [key, value] of entries) query.set(key, String(value));
      url += '?' + query.toString();
    }

    log.sub('API').tag('REQUEST').debug('Provider request', { method, url });

    const options: RequestInit = {
      method,
      headers: buildAuthHeaders(this.config),
      body,
    };

    const res = await authenticatedRequest(url, this.config, options);
    const text = await res.text();
    let data: DnsnekoApiResponse<T>;
    try { data = JSON.parse(text); } catch { data = { code: res.status, data: undefined as T }; }

    if (!res.ok) {
      this.error = data.message || `HTTP ${res.status}`;
      throw new Error(this.error);
    }

    return data;
  }

  async check(): Promise<boolean> {
    try {
      await this.request('GET', '/domains', { page: 1, size: 1, domainType: 'all' });
      return true;
    } catch {
      return false;
    }
  }

  async getDomainList(keyword?: string, page = 1, pageSize = 50): Promise<PageResult<DomainInfo>> {
    try {
      const params: Dict = { page, size: pageSize, domainType: 'all' };
      if (keyword) params.keyword = keyword;

      const data = await this.request<{ domains: DnsnekoDomain[]; total: string; pages: string }>('GET', '/domains', params);
      const domains = data.data?.domains || [];
      const list = domains.map((item) => ({
        Domain: item.domain,
        ThirdId: `${item.domainType}:${item.id}`,
        RecordCount: item.recordCount ? parseInt(item.recordCount) : undefined,
        ExpiresAt: item.expireTime,
        AdapterData: item,
      }));

      return { total: list.length, list };
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
    line?: string,
    status?: number
  ): Promise<PageResult<DnsRecord>> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) return { total: 0, list: [] };

      const parsed = this.parseDomainRef();
      const params: Dict = { domainId, page, size: pageSize, domainType: parsed.domainType };
      if (type) params.type = type;
      if (keyword) params.keyword = keyword;

      const data = await this.request<{ records: DnsnekoRecord[]; domainId: string; domain: string; domainType: string }>('GET', '/records', params);

      let list = (data.data?.records || []).map((r) => this.mapRecord(r));

      if (subdomain) list = list.filter((r) => r.Name.toLowerCase() === subdomain.toLowerCase());
      if (value) list = list.filter((r) => r.Value.toLowerCase().includes(value.toLowerCase()));
      if (line) list = list.filter((r) => r.Line === line);
      if (status !== undefined) list = list.filter((r) => r.Status === status);

      return { total: list.length, list };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return { total: 0, list: [] };
    }
  }

  async getDomainRecordInfo(recordId: string): Promise<DnsRecord | null> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) return null;

      const parsed = this.parseDomainRef();
      const data = await this.request<{ records: DnsnekoRecord[] }>('GET', '/records', { domainId, page: 1, size: 100, domainType: parsed.domainType });
      const record = data.data?.records?.find((r) => String(r.id) === recordId);
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
      if (!domainId) return null;

      const parsed = this.parseDomainRef();
      const body: Dict = {
        name: normalizeRrName(name),
        type,
        value,
        line: this.normalizeLine(line),
        ttl,
        remark,
      };

      if (type === 'MX' || type === 'SRV') body.priority = mx;
      if (weight !== undefined) body.weight = weight;

      const data = await this.request<Dict>('POST', `/records/${domainId}`, body, { domainType: parsed.domainType });

      if (data.data) {
        const id = data.data.id ?? data.data.record_id ?? data.data.Id;
        if (id) return String(id);
      }
      const topId = (data as unknown as Dict).id ?? (data as unknown as Dict).record_id;
      if (topId) return String(topId);

      const rawName = normalizeRrName(name);
      const scan = await this.request<{ records: DnsnekoRecord[] }>('GET', '/records', { domainId, page: 1, size: 100, domainType: parsed.domainType });
      const match = scan.data?.records?.find((r) =>
        normalizeRrName(r.name) === rawName && r.type === type && r.value === value
      );
      if (match) return String(match.id);

      return null;
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
      if (!domainId) return false;

      const parsed = this.parseDomainRef();
      const body: Dict = {
        name: normalizeRrName(name),
        type,
        value,
        line: this.normalizeLine(line),
        ttl,
        remark,
      };

      if (type === 'MX' || type === 'SRV') body.priority = mx;
      if (weight !== undefined) body.weight = weight;

      await this.request<unknown>('PUT', `/records/${domainId}/${recordId}`, body, { domainType: parsed.domainType });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) return false;

      const parsed = this.parseDomainRef();
      await this.request<unknown>('DELETE', `/records/${domainId}/${recordId}`, undefined, { domainType: parsed.domainType });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async setDomainRecordStatus(recordId: string, status: number): Promise<boolean> {
    try {
      const parsed = this.parseDomainRef();
      await this.request<unknown>('POST', `/records/${recordId}/status`, { status }, { domainType: parsed.domainType });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      log.error('setDomainRecordStatus failed', { recordId, status, error: this.error });
      return false;
    }
  }

  async getRecordLines(): Promise<Array<{ id: string; name?: string }>> {
    try {
      const res = await this.request<{
        defaultOption?: { value: string; labelZh: string; available?: boolean };
        categories?: Array<{
          options?: Array<{ value: string; labelZh: string; available?: boolean }>;
        }>;
      }>('GET', '/geo-lines');

      if (res.code !== 200 || !res.data) {
        this.error = '线路查询失败（dnsneko）';
        throw new Error(this.error);
      }

      const lines: Array<{ id: string; name?: string }> = [];
      if (res.data.defaultOption?.value && res.data.defaultOption.available !== false) {
        lines.push({ id: res.data.defaultOption.value, name: res.data.defaultOption.labelZh });
      }
      if (Array.isArray(res.data.categories)) {
        for (const cat of res.data.categories) {
          if (Array.isArray(cat.options)) {
            for (const opt of cat.options) {
              if (opt.value && opt.available !== false) {
                lines.push({ id: opt.value, name: opt.labelZh });
              }
            }
          }
        }
      }
      return lines.length > 0 ? lines : [{ id: 'default' }];
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  async getMinTTL(): Promise<number> {
    return 60;
  }

  async addDomain(domain: string): Promise<boolean> {
    this.error = 'Dnsneko does not support domain registration via API';
    return false;
  }

  private normalizeLine(line?: string): string {
    const lineMap: Record<string, string> = {
      '0': 'default',
      '1': 'default',
    };
    return lineMap[line || ''] || resolveProviderLine(line, 'default');
  }

  private mapRecord(r: DnsnekoRecord): DnsRecord {
    return {
      RecordId: String(r.id),
      Domain: this.config.domain || '',
      Name: normalizeRrName(safeString(r.name)),
      Type: safeString(r.type).toUpperCase(),
      Value: safeString(r.value),
      Line: resolveProviderLine(r.line, 'default'),
      TTL: r.ttl ?? 600,
      MX: r.priority ?? 0,
      Status: r.status === 1 ? 1 : 0,
      Remark: safeString(r.remark) || undefined,
    };
  }
}
