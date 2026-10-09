import {
  createProviderAdapterLogger,
  DnsAdapter,
  DnsRecord,
  DomainInfo,
  PageResult,
  normalizeRrName,
  safeString,
  resolveDomainIdHelper,
  Dict,
} from '../internal';
import { authenticatedRequest, type HidnsV2AuthConfig } from './auth';

const log = createProviderAdapterLogger('HiDNS-V2');

interface HidnsV2Config extends HidnsV2AuthConfig {
  domain?: string;
  domainId?: string;
  zoneId?: string;
}

interface HidnsV2ApiResponse<T> {
  code: number;
  message?: string;
  data?: T;
}

interface HidnsV2Domain {
  id: string | number;
  name: string;
  domain?: string;
  domainType: string;
  third_id?: string;
  record_count?: number;
  recordCount?: number;
  expires_at?: string;
  expireTime?: string;
  status: number;
  upstreamProvider?: string;
}

interface HidnsV2Record {
  id: string;
  name: string;
  type: string;
  value: string;
  line: string;
  ttl: number;
  mx?: number;
  priority?: number;
  weight?: number;
  remark?: string;
  status: number;
  updated_at?: string;
  updateTime?: string;
  proxiable?: boolean;
  cloudflare?: {
    proxied?: boolean;
    proxiable?: boolean;
  } | null;
}

export class HidnsV2Adapter implements DnsAdapter {
  private config: HidnsV2Config;
  private error = '';

  constructor(config: Record<string, string>) {
    this.config = {
      baseUrl: safeString(config.baseUrl || ''),
      apiToken: safeString(config.apiToken || ''),
      domain: safeString(config.domain),
      domainId: safeString(config.domainId),
      zoneId: safeString(config.zoneId),
      useProxy: !!config.useProxy,
    };
  }

  getError(): string {
    return this.error;
  }

  private async request<T>(method: string, path: string, params?: Dict): Promise<HidnsV2ApiResponse<T>> {
    const baseUrl = this.config.baseUrl.replace(/\/api\/?$/, '');
    let url = `${baseUrl}/api${path}`;
    let body: string | undefined;

    if (method === 'GET' && params) {
      const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
      if (entries.length > 0) {
        url += '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
      }
    } else if (params) {
      body = JSON.stringify(params);
    }

    log.sub('API').tag('REQUEST').debug('Provider request', { method, url });

    try {
      const res = await authenticatedRequest(url, this.config, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      const text = await res.text();
      let data: HidnsV2ApiResponse<T>;
      try { data = JSON.parse(text); } catch { data = { code: res.status, data: undefined as T }; }

      log.sub('API').tag('RESPONSE').debug('Provider response', { status: res.status, code: data.code });

      if (!res.ok || data.code !== 0) {
        this.error = data.message || `HTTP ${res.status}`;
      }

      return data;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      log.sub('API').tag('ERROR').error('Provider request failed', [{ message: this.error }]);
      return { code: -1, message: this.error };
    }
  }

  async check(): Promise<boolean> {
    try {
      const baseUrl = this.config.baseUrl.replace(/\/api\/?$/, '');
      // 探测专供 API 版本号端点（provider 探针专用，与主体 /api/system/version 区分）
      const verRes = await authenticatedRequest(`${baseUrl}/api/version`, this.config, { method: 'GET' });
      if (!verRes.ok) return false;
      const verBody = await verRes.json();
      const apiVersion = String(verBody?.data?.apiVersion ?? verBody?.apiVersion ?? '');
      if (!apiVersion) {
        this.error = 'Server does not expose an API version (apiVersion missing)';
        return false;
      }
      if (apiVersion !== '2' && apiVersion !== 'v2') {
        this.error = `Server API version is not v2 (got: ${apiVersion})`;
        return false;
      }
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async getDomainList(keyword?: string, page = 1, pageSize = 50): Promise<PageResult<DomainInfo>> {
    try {
      const params: Dict = { page, pageSize };
      if (keyword) params.keyword = keyword;

      const res = await this.request<{ total: number; list: HidnsV2Domain[] } | HidnsV2Domain[]>('GET', '/domains', params);

      if (res.code !== 0) {
        return { total: 0, list: [] };
      }

      // 兼容两种返回格式：{ total, list } 或直接数组（token 认证时为数组）
      const data = res.data;
      const domains: HidnsV2Domain[] = Array.isArray(data) ? data : (data?.list || []);
      const total = Array.isArray(data) ? domains.length : (data?.total || domains.length);

      return {
        total,
        list: domains.map((d) => {
          // 记录接口以域名数字 id 定位（third_id 不可用于 records 路径）
          const id = String(d.id ?? d.third_id ?? '');
          return {
            Domain: d.name || d.domain || '',
            ThirdId: id,
            RecordCount: d.record_count || d.recordCount || 0,
            ExpiresAt: d.expires_at || d.expireTime,
            AdapterData: { ...d, _id: id },
          };
        }),
      };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      log.error('getDomainList failed', this.error);
      return { total: 0, list: [] };
    }
  }

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

    const id = await resolveDomainIdHelper(this.config, this.getDomainList.bind(this), 'HiDNS-V2');
    if (!id) return null;

    return id.includes(':') ? id.split(':', 2)[1] : id;
  }

  async getDomainRecords(
    page = 1,
    pageSize = 100,
    keyword?: string,
    subdomain?: string,
    value?: string,
    type?: string,
    _line?: string,
    _status?: number,
  ): Promise<PageResult<DnsRecord>> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) return { total: 0, list: [] };

      const parsed = this.parseDomainRef();
      const params: Dict = { page, pageSize, domainType: parsed.domainType };
      if (type) params.type = type;
      if (keyword) params.keyword = keyword;

      const res = await this.request<{ total: number; list: HidnsV2Record[] }>('GET', `/domains/${domainId}/records`, params);

      if (res.code !== 0) return { total: 0, list: [] };

      let list = (res.data?.list || []).map((r) => this.mapRecord(r));

      if (subdomain) list = list.filter((r) => r.Name.toLowerCase() === subdomain.toLowerCase());
      if (value) list = list.filter((r) => r.Value.toLowerCase().includes(value.toLowerCase()));

      return { total: res.data?.total || list.length, list };
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
      const res = await this.request<{ list: HidnsV2Record[] }>('GET', `/domains/${domainId}/records`, { page: 1, pageSize: 100, domainType: parsed.domainType });
      const record = res.data?.list?.find((r) => String(r.id) === recordId);
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
    remark?: string,
  ): Promise<string | null> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) return null;

      const parsed = this.parseDomainRef();
      const body: Dict = {
        name: normalizeRrName(name),
        type,
        value,
        line: line || '0',
        ttl,
        remark,
        domainType: parsed.domainType,
      };
      if (type === 'MX' || type === 'SRV') body.mx = mx;
      if (weight !== undefined) body.weight = weight;

      const res = await this.request<{ id: string }>('POST', `/domains/${domainId}/records`, body);

      if (res.data?.id) return String(res.data.id);

      const rawName = normalizeRrName(name);
      const scan = await this.request<{ list: HidnsV2Record[] }>('GET', `/domains/${domainId}/records`, { page: 1, pageSize: 100, domainType: parsed.domainType });
      const match = scan.data?.list?.find((r) =>
        normalizeRrName(r.name) === rawName && r.type === type && r.value === value,
      );
      return match ? String(match.id) : null;
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
    remark?: string,
  ): Promise<boolean> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) return false;

      const body: Dict = {
        name: normalizeRrName(name),
        type,
        value,
        line: line || '0',
        ttl,
        remark,
      };
      if (type === 'MX' || type === 'SRV') body.mx = mx;
      if (weight !== undefined) body.weight = weight;

      const res = await this.request<unknown>('PUT', `/domains/${domainId}/records/${recordId}`, body);
      return res.code === 0;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) return false;

      const res = await this.request<unknown>('DELETE', `/domains/${domainId}/records/${recordId}`);
      return res.code === 0;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async setDomainRecordStatus(recordId: string, status: number): Promise<boolean> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) return false;

      const res = await this.request<unknown>('PUT', `/domains/${domainId}/records/${recordId}/status`, { status });
      return res.code === 0;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      log.error('setDomainRecordStatus failed', { recordId, status, error: this.error });
      return false;
    }
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) return [{ id: '0', name: '默认' }];

      const res = await this.request<Array<{ id: string; name: string }>>('GET', `/domains/${domainId}/lines`);
      if (res.code === 0 && Array.isArray(res.data)) {
        return res.data;
      }
      return [{ id: '0', name: '默认' }];
    } catch {
      return [{ id: '0', name: '默认' }];
    }
  }

  async getRecordTypes(): Promise<Array<{ type: string; name?: string }>> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) return [];

      const res = await this.request<Array<{ type: string; name?: string }>>('GET', `/domains/${domainId}/record-types`);
      if (res.code === 0 && Array.isArray(res.data)) {
        return res.data;
      }
      return [];
    } catch {
      return [];
    }
  }

  async getMinTTL(): Promise<number> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) return 60;

      const lines = await this.getRecordLines();
      if (lines.length > 0) return 60;
      return 60;
    } catch {
      return 60;
    }
  }

  async addDomain(_domain: string): Promise<boolean> {
    this.error = 'HiDNS does not support domain registration via API';
    return false;
  }

  private mapRecord(r: HidnsV2Record): DnsRecord {
    const record: DnsRecord = {
      RecordId: String(r.id),
      Domain: this.config.domain || '',
      Name: normalizeRrName(safeString(r.name)),
      Type: safeString(r.type).toUpperCase(),
      Value: safeString(r.value),
      Line: r.line || '0',
      TTL: r.ttl ?? 600,
      MX: r.mx ?? r.priority ?? 0,
      Status: r.status === 1 ? 1 : 0,
      Weight: r.weight,
      Remark: safeString(r.remark) || undefined,
      UpdateTime: r.updated_at || r.updateTime,
    };

    if (r.proxiable !== undefined) {
      record.Proxiable = r.proxiable;
    }

    if (r.cloudflare) {
      record.Cloudflare = r.cloudflare;
    }

    return record;
  }
}
