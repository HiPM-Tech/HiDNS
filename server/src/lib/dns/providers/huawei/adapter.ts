import { createProviderAdapterLogger, DnsAdapter, DnsRecord, DomainInfo, PageResult, asArray, BaseAdapter, Dict, normalizeRrName, resolveDomainIdHelper, safeString, toNumber, toRecordStatus, uuid, fetchWithFallback, resolveProviderLine } from '../internal';
import crypto from 'node:crypto';

const log = createProviderAdapterLogger('Huawei');
class HuaweiCloudClient {
  private readonly useProxy: boolean;

  constructor(
    private readonly accessKeyId: string,
    private readonly secretAccessKey: string,
    private readonly endpoint: string = 'dns.myhuaweicloud.com',
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

  private getCanonicalURI(path: string): string {
    if (!path) return '/';
    const parts = path.split('/').map((item) => this.escape(item));
    let canonicalURI = parts.join('/');
    if (!canonicalURI.endsWith('/')) canonicalURI += '/';
    return canonicalURI;
  }

  private getCanonicalQueryString(params: Record<string, string> | null): string {
    if (!params) return '';
    const sorted = Object.keys(params).sort();
    const parts: string[] = [];
    for (const key of sorted) {
      if (params[key] !== undefined && params[key] !== null) {
        parts.push(`${this.escape(key)}=${this.escape(params[key])}`);
      }
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
      canonical += `${key}:${normalized[key]}\n`;
      signed += `${key};`;
    }
    return [canonical, signed.slice(0, -1)];
  }

  private generateSign(
    method: string,
    path: string,
    query: Record<string, string> | null,
    headers: Record<string, string>,
    body: string,
    timestamp: number
  ): string {
    const algorithm = 'SDK-HMAC-SHA256';
    const date = new Date(timestamp * 1000).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';

    const canonicalURI = this.getCanonicalURI(path);
    const canonicalQuery = this.getCanonicalQueryString(query);
    const [canonicalHeaders, signedHeaders] = this.getCanonicalHeaders(headers);
    const hashedPayload = crypto.createHash('sha256').update(body).digest('hex');

    const canonicalRequest = `${method}\n${canonicalURI}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;

    const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
    const stringToSign = `${algorithm}\n${date}\n${hashedCanonicalRequest}`;

    const signature = crypto.createHmac('sha256', this.secretAccessKey).update(stringToSign).digest('hex');

    return `${algorithm} Access=${this.accessKeyId}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  }

  async request<T = Dict>(
    method: string,
    path: string,
    query?: Record<string, string> | null,
    body?: Dict
  ): Promise<T> {
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';

    const headers: Record<string, string> = {
      Host: this.endpoint,
      'X-Sdk-Date': date,
    };

    let bodyStr = '';
    if (body && Object.keys(body).length > 0) {
      headers['Content-Type'] = 'application/json';
      bodyStr = JSON.stringify(body);
    }

    const authorization = this.generateSign(method, path, query || null, headers, bodyStr, timestamp);
    headers['Authorization'] = authorization;

    let url = `https://${this.endpoint}${path}`;
    if (query && Object.keys(query).length > 0) {
      const queryStr = this.getCanonicalQueryString(query);
      if (queryStr) url += '?' + queryStr;
    }

    log.sub('API').tag('REQUEST').debug('Provider request', { method: method, url: url, params: undefined });
    const res = await fetchWithFallback(url, {
      method,
      headers,
      body: bodyStr || undefined,
    }, this.useProxy, 'Huawei');

    const data = (await res.json()) as Dict;
    if (!res.ok || data.error_msg || data.message || (data.error as Dict)?.error_msg) {
      const err = safeString(data.error_msg) || safeString(data.message) || safeString((data.error as Dict)?.error_msg) || `HuaweiCloud request failed: ${res.status}`;
      log.sub('API').tag('ERROR').error('Provider error', data);
      throw new Error(err);
    }
    log.sub('API').tag('RESPONSE').debug('Provider response', { status: res.status, success: true, data: undefined });

    return data as T;
  }
}

interface HuaweiConfig {
  AccessKeyId: string;
  SecretAccessKey: string;
  domain?: string;
  domainId?: string;
  useProxy?: boolean;
}

export class HuaweiAdapter extends BaseAdapter {
  private config: HuaweiConfig;
  private client: HuaweiCloudClient;

  constructor(config: Record<string, string>) {
    super();
    this.config = {
      AccessKeyId: safeString(config.AccessKeyId),
      SecretAccessKey: safeString(config.SecretAccessKey),
      domain: safeString(config.domain),
      domainId: safeString(config.zoneId),
      useProxy: !!config.useProxy,
    };
    this.client = new HuaweiCloudClient(this.config.AccessKeyId, this.config.SecretAccessKey, 'dns.myhuaweicloud.com', this.config.useProxy);
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
      const offset = (page - 1) * pageSize;
      const query: Record<string, string> = {
        offset: String(offset),
        limit: String(pageSize),
      };
      if (keyword) query.name = keyword;

      const data = await this.client.request<{ zones: Array<{ id: string; name: string; record_num: number }>; metadata: { total_count: number } }>(
        'GET',
        '/v2/zones',
        query
      );

      const list = (data.zones || []).map((item) => ({
        Domain: item.name.replace(/\.$/, ''),
        ThirdId: item.id,
        RecordCount: item.record_num,
      }));

      return { total: data.metadata?.total_count || list.length, list };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      log.error('getDomainList failed', this.error);
      return { total: 0, list: [] };
    }
  }

  /**
   * 根据域名查找 Domain ID (Zone ID)
   * 当 config.domainId 未设置时，尝试通过域名搜索获取
   */
  private async resolveDomainId(): Promise<string | null> {
    return resolveDomainIdHelper(this.config, this.getDomainList.bind(this), 'Huawei');
  }

  async getDomainRecords(
    page = 1,
    pageSize = 20,
    keyword?: string,
    subdomain?: string,
    _value?: string,
    type?: string,
    line?: string,
    status?: number
  ): Promise<PageResult<DnsRecord>> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        return { total: 0, list: [] };
      }

      const offset = (page - 1) * pageSize;
      const query: Record<string, string> = {
        offset: String(offset),
        limit: String(pageSize),
      };

      if (type) query.type = type;
      if (line && line !== '0') query.line_id = line;
      if (status !== undefined) query.status = status === 1 ? 'ACTIVE' : 'DISABLE';

      if (subdomain) {
        query.name = this.getHost(subdomain);
        query.search_mode = 'equal';
      } else if (keyword) {
        query.name = keyword;
      }

      const data = await this.client.request<{
        recordsets: Dict[];
        metadata: { total_count: number };
      }>('GET', `/v2.1/zones/${domainId}/recordsets`, query);

      const list = (data.recordsets || []).map((row) => this.mapRecord(row));
      return { total: data.metadata?.total_count || list.length, list };
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

      const data = await this.client.request<Dict>('GET', `/v2.1/zones/${domainId}/recordsets/${recordId}`);
      return this.mapRecord(data);
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
    _mx?: number,
    weight?: number,
    remark?: string
  ): Promise<string | null> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        return null;
      }

      const hostName = this.getHost(name);
      let recordValue = value;
      if (type === 'TXT' && !recordValue.startsWith('"')) {
        recordValue = `"${recordValue}"`;
      }
      const records = recordValue.split(',').reverse();

      const body: Dict = {
        name: hostName,
        type: this.convertType(type),
        records: records,
        // 华为云线路 ID 没有 '0'：未指定时用官方默认线路 default_view
        line: resolveProviderLine(line, 'default_view'),
        ttl: ttl,
        description: remark,
      };

      if (weight && weight > 0) {
        body.weight = weight;
      }

      const data = await this.client.request<{ id: string }>(
        'POST',
        `/v2.1/zones/${domainId}/recordsets`,
        null,
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
    _mx?: number,
    weight?: number,
    remark?: string
  ): Promise<boolean> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        return false;
      }

      const hostName = this.getHost(name);
      let recordValue = value;
      if (type === 'TXT' && !recordValue.startsWith('"')) {
        recordValue = `"${recordValue}"`;
      }
      const records = recordValue.split(',').reverse();

      // 华为云 UpdateRecordSets 不接受 line（线路创建后不可改），这里显式不透传
      void line;
      const body: Dict = {
        name: hostName,
        type: this.convertType(type),
        records: records,
        ttl: ttl,
        description: remark,
      };

      if (weight && weight > 0) {
        body.weight = weight;
      }

      await this.client.request('PUT', `/v2.1/zones/${domainId}/recordsets/${recordId}`, null, body);
      return true;
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

      await this.client.request('DELETE', `/v2.1/zones/${domainId}/recordsets/${recordId}`);
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async setDomainRecordStatus(recordId: string, status: number): Promise<boolean> {
    try {
      const body = { status: status === 1 ? 'ENABLE' : 'DISABLE' };
      await this.client.request('PUT', `/v2.1/recordsets/${recordId}/statuses/set`, null, body);
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    try {
      // 官方接口：GET /v2.1/system-lines（ListSystemLines，支持 limit/offset 分页）
      const pageSize = 500;
      const collected = new Map<string, string>();
      let offset = 0;
      for (let page = 0; page < 10; page += 1) {
        const data = await this.client.request<{
          lines?: Dict[];
          recordsets?: Dict[];
          metadata?: { total_count?: number };
        }>('GET', '/v2.1/system-lines', {
          limit: String(pageSize),
          offset: String(offset),
        });
        const rows = asArray<Dict>(data.lines ?? data.recordsets);
        for (const row of rows) {
          const id = safeString(row.id);
          if (!id || collected.has(id)) continue;
          collected.set(id, safeString(row.name) || id);
        }
        const total = toNumber(data.metadata?.total_count, 0);
        if (rows.length < pageSize || (total > 0 && collected.size >= total)) break;
        offset += pageSize;
      }

      if (collected.size === 0) {
        this.error = '华为云线路列表为空（ListSystemLines 返回 0 条）';
        throw new Error(this.error);
      }

      // default_view 必须排首位：前端按「首项=默认」取默认线路，
      // 而华为云线路创建后不可改，错建只能用删除重建。
      const entries = [...collected.entries()].map(([id, name]) => ({ id, name }));
      return [
        ...entries.filter((line) => line.id === 'default_view'),
        ...entries.filter((line) => line.id !== 'default_view'),
      ];
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  async getMinTTL(): Promise<number> {
    return 1;
  }

  async addDomain(domain: string): Promise<boolean> {
    try {
      const body = { name: domain };
      await this.client.request('POST', '/v2/zones', null, body);
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  private convertType(type: string): string {
    return type;
  }

  private getHost(name: string): string {
    if (name === '@') return `${this.config.domain}.`;
    return `${name}.${this.config.domain}.`;
  }

  private mapRecord(row: Dict): DnsRecord {
    const domain = this.config.domain || '';
    const zoneName = safeString(row.zone_name);
    let name = '';
    const recordName = safeString(row.name);
    if (recordName === `${zoneName}.`) {
      name = '@';
    } else {
      name = recordName.replace(`.${zoneName}.`, '');
    }

    return {
      RecordId: safeString(row.id),
      Domain: zoneName.replace(/\.$/, ''),
      Name: name,
      Type: safeString(row.type),
      Value: Array.isArray(row.records) ? row.records.join(',') : safeString(row.records),
      Line: safeString(row.line) || 'default_view',
      TTL: toNumber(row.ttl, 600),
      MX: row.mx ? toNumber(row.mx, 0) : 0,
      Status: row.status === 'ACTIVE' ? 1 : 0,
      Weight: row.weight ? toNumber(row.weight, 0) : undefined,
      Remark: safeString(row.description) || undefined,
      UpdateTime: safeString(row.updated_at) || undefined,
    };
  }
}
