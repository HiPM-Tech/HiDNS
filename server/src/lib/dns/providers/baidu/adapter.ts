import { createProviderAdapterLogger, DnsAdapter, DnsRecord, DomainInfo, PageResult, asArray, BaseAdapter, Dict, normalizeRrName, safeString, toNumber, toRecordStatus, uuid, fetchWithFallback, resolveProviderLine } from '../internal';
import crypto from 'node:crypto';

const log = createProviderAdapterLogger('Baidu');
class BaiduCloudClient {
  private readonly useProxy: boolean;

  constructor(
    private readonly accessKeyId: string,
    private readonly secretAccessKey: string,
    private readonly endpoint: string = 'dns.baidubce.com',
    useProxy: boolean = false
  ) {
    this.useProxy = useProxy;
  }

  private escape(str: string): string {
    return encodeURIComponent(str)
      .replace(/\+/g, '%20')
      .replace(/\*/g, '%2A')
      .replace(/%7E/g, '~');
  }

  private getCanonicalUri(path: string): string {
    if (!path) return '/';
    let uri = this.escape(path).replace(/%2F/g, '/');
    if (!uri.startsWith('/')) uri = '/' + uri;
    return uri;
  }

  private getCanonicalQueryString(params: Record<string, string> | null): string {
    if (!params) return '';
    const sorted = Object.keys(params).sort();
    const parts: string[] = [];
    for (const key of sorted) {
      if (key.toLowerCase() === 'authorization') continue;
      parts.push(`${this.escape(key)}=${this.escape(params[key])}`);
    }
    return parts.join('&');
  }

  private getCanonicalHeaders(headers: Record<string, string>): [string, string] {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      normalized[key.toLowerCase()] = value.trim();
    }
    const sorted = Object.keys(normalized).sort();
    let canonical = '';
    let signed = '';
    for (const key of sorted) {
      canonical += `${this.escape(key)}:${this.escape(normalized[key])}\n`;
      signed += `${key};`;
    }
    return [canonical, signed.slice(0, -1)];
  }

  private generateSign(
    method: string,
    path: string,
    query: Record<string, string> | null,
    headers: Record<string, string>,
    timestamp: number
  ): string {
    const algorithm = 'bce-auth-v1';
    const date = new Date(timestamp * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const expiration = 1800;

    const canonicalUri = this.getCanonicalUri(path);
    const canonicalQuery = this.getCanonicalQueryString(query);
    const [canonicalHeaders, signedHeaders] = this.getCanonicalHeaders(headers);

    const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}`;

    const authString = `${algorithm}/${this.accessKeyId}/${date}/${expiration}`;
    const signingKey = crypto.createHmac('sha256', this.secretAccessKey).update(authString).digest('hex');
    const signature = crypto.createHmac('sha256', signingKey).update(canonicalRequest).digest('hex');

    return `${authString}/${signedHeaders}/${signature}`;
  }

  async request<T = Dict>(
    method: string,
    path: string,
    query?: Record<string, string> | null,
    body?: Dict
  ): Promise<T> {
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

    const headers: Record<string, string> = {
      Host: this.endpoint,
      'x-bce-date': date,
    };

    let bodyStr = '';
    if (body && Object.keys(body).length > 0) {
      headers['Content-Type'] = 'application/json';
      bodyStr = JSON.stringify(body);
    }

    const authorization = this.generateSign(method, path, query || null, headers, timestamp);
    headers['Authorization'] = authorization;

    let url = `https://${this.endpoint}${path}`;
    if (query && Object.keys(query).length > 0) {
      url += '?' + this.getCanonicalQueryString(query);
    }

    const res = await fetchWithFallback(url, {
      method,
      headers,
      body: bodyStr || undefined,
    }, this.useProxy, 'Baidu');

    if (res.status === 200 && res.headers.get('content-length') === '0') {
      return {} as T;
    }

    const data = (await res.json()) as Dict;
    if (!res.ok || data.code) {
      throw new Error(safeString(data.message) || `BaiduCloud request failed: ${res.status}`);
    }

    return data as T;
  }
}

interface BaiduConfig {
  AccessKeyId: string;
  SecretAccessKey: string;
  domain?: string;
  domainId?: string;
  useProxy?: boolean;
}

export class BaiduAdapter extends BaseAdapter {
  private config: BaiduConfig;
  private client: BaiduCloudClient;

  constructor(config: Record<string, string>) {
    super();
    this.config = {
      AccessKeyId: safeString(config.AccessKeyId),
      SecretAccessKey: safeString(config.SecretAccessKey),
      domain: safeString(config.domain),
      domainId: safeString(config.zoneId),
      useProxy: !!config.useProxy,
    };
    this.client = new BaiduCloudClient(this.config.AccessKeyId, this.config.SecretAccessKey, 'dns.baidubce.com', this.config.useProxy);
  }

  async check(): Promise<boolean> {
    try {
      await this.getDomainList();
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async getDomainList(keyword?: string, page = 1, pageSize = 20): Promise<PageResult<DomainInfo>> {
    try {
      const query: Record<string, string> = {};
      if (keyword) query.name = keyword;

      const data = await this.client.request<{ zones: Array<{ id: string; name: string }> }>(
        'GET',
        '/v1/dns/zone',
        query
      );

      const list = (data.zones || []).map((item) => ({
        Domain: item.name.replace(/\.$/, ''),
        ThirdId: item.id,
        RecordCount: 0,
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
    pageSize = 20,
    keyword?: string,
    subdomain?: string,
    value?: string,
    type?: string,
    line?: string,
    status?: number
  ): Promise<PageResult<DnsRecord>> {
    try {
      if (!this.config.domain) {
        this.error = this.error || '读取记录失败：未解析到域名或上游返回空结果';
        return { total: 0, list: [] };
      }

      const query: Record<string, string> = {};
      if (subdomain) {
        query.rr = subdomain.toLowerCase();
      }

      const data = await this.client.request<{ records: Dict[] }>(
        'GET',
        `/v1/dns/zone/${this.config.domain}/record`,
        query
      );

      let list = (data.records || []).map((row) => this.mapRecord(row));

      if (subdomain) {
        list = list.filter((r) => r.Name.toLowerCase() === subdomain.toLowerCase());
      } else {
        if (keyword) {
          const lowerKeyword = keyword.toLowerCase();
          list = list.filter(
            (r) => r.Name.toLowerCase().includes(lowerKeyword) || r.Value.toLowerCase().includes(lowerKeyword)
          );
        }
        if (value) {
          list = list.filter((r) => r.Value === value);
        }
        if (type) {
          list = list.filter((r) => r.Type === type);
        }
        if (status !== undefined) {
          list = list.filter((r) => r.Status === status);
        }
      }

      return { total: list.length, list };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return { total: 0, list: [] };
    }
  }

  async getDomainRecordInfo(recordId: string): Promise<DnsRecord | null> {
    try {
      if (!this.config.domain) {
        return null;
      }

      const data = await this.client.request<{ records: Dict[] }>(
        'GET',
        `/v1/dns/zone/${this.config.domain}/record`,
        { id: recordId }
      );

      if (!data.records || data.records.length === 0) {
        return null;
      }

      return this.mapRecord(data.records[0]);
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
    _weight?: number,
    remark?: string
  ): Promise<string | null> {
    try {
      if (!this.config.domain) {
        return null;
      }

      const body: Dict = {
        rr: name,
        type: this.convertType(type),
        value: value,
        line: resolveProviderLine(line, 'default'),
        ttl: ttl,
        description: remark,
      };

      if (type === 'MX') {
        body.priority = mx;
      }

      const query = { clientToken: uuid() };
      const data = await this.client.request<{ id: string }>(
        'POST',
        `/v1/dns/zone/${this.config.domain}/record`,
        query,
        body
      );

      return data.id || null;
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
    _weight?: number,
    remark?: string
  ): Promise<boolean> {
    try {
      if (!this.config.domain) {
        return false;
      }

      const body: Dict = {
        rr: name,
        type: this.convertType(type),
        value: value,
        line: resolveProviderLine(line, 'default'),
        ttl: ttl,
        description: remark,
      };

      if (type === 'MX') {
        body.priority = mx;
      }

      const query = { clientToken: uuid() };
      await this.client.request(
        'PUT',
        `/v1/dns/zone/${this.config.domain}/record/${recordId}`,
        query,
        body
      );

      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    try {
      if (!this.config.domain) {
        return false;
      }

      const query = { clientToken: uuid() };
      await this.client.request('DELETE', `/v1/dns/zone/${this.config.domain}/record/${recordId}`, query);
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async setDomainRecordStatus(recordId: string, status: number): Promise<boolean> {
    try {
      if (!this.config.domain) {
        return false;
      }

      const action = status === 1 ? 'enable' : 'disable';
      const query: Record<string, string> = { clientToken: uuid() };
      query[action] = '';

      await this.client.request('PUT', `/v1/dns/zone/${this.config.domain}/record/${recordId}`, query);
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    return [
      { id: 'default', name: '默认' },
      { id: 'ct', name: '电信' },
      { id: 'cnc', name: '联通' },
      { id: 'cmnet', name: '移动' },
      { id: 'edu', name: '教育网' },
      { id: 'search', name: '搜索引擎(百度)' },
    ];
  }

  async getMinTTL(): Promise<number> {
    return 1;
  }

  async addDomain(domain: string): Promise<boolean> {
    try {
      const query = { clientToken: uuid(), name: domain };
      await this.client.request('POST', '/v1/dns/zone', query);
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  private convertType(type: string): string {
    return type;
  }

  private mapRecord(row: Dict): DnsRecord {
    const domain = this.config.domain || '';
    return {
      RecordId: safeString(row.id),
      Domain: domain,
      Name: safeString(row.rr),
      Type: safeString(row.type),
      Value: safeString(row.value),
      Line: safeString(row.line) || 'default',
      TTL: toNumber(row.ttl, 600),
      MX: toNumber(row.priority, 0),
      Status: row.status === 'running' ? 1 : 0,
      Weight: undefined,
      Remark: safeString(row.description) || undefined,
      UpdateTime: undefined,
    };
  }
}
