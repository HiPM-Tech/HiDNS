import { createProviderAdapterLogger, DnsAdapter, DnsRecord, DomainInfo, PageResult, BaseAdapter, Dict, resolveDomainIdHelper, safeString, toNumber, uuid, fetchWithFallback, resolveProviderLine, normalizeLine } from '../internal';
import crypto from 'node:crypto';
export const DEFAULT_LINE = '0';

const log = createProviderAdapterLogger('Jdcloud');
interface JdcloudConfig {
  AccessKeyId: string;
  AccessKeySecret: string;
  domain?: string;
  domainId?: string;
  useProxy?: boolean;
}

class JdcloudClient {
  private algorithm = 'JDCLOUD2-HMAC-SHA256';
  private endpoint = 'domainservice.jdcloud-api.com';
  private service = 'domainservice';
  private version = 'v2';
  private region = 'cn-north-1';

  constructor(
    private accessKeyId: string,
    private accessKeySecret: string,
    private useProxy: boolean = false
  ) {}

  private escape(str: string): string {
    return encodeURIComponent(str)
      .replace(/\+/g, '%20')
      .replace(/\*/g, '%2A')
      .replace(/%7E/g, '~');
  }

  private getCanonicalQueryString(params: Record<string, string>): string {
    const sorted = Object.keys(params).sort();
    const parts: string[] = [];
    for (const key of sorted) {
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
      canonical += `${key}:${normalized[key]}\n`;
      signed += `${key};`;
    }
    return [canonical, signed.slice(0, -1)];
  }

  private generateSign(
    method: string,
    path: string,
    query: Record<string, string>,
    headers: Record<string, string>,
    body: string,
    date: string
  ): string {
    const canonicalUri = path;
    const canonicalQuery = this.getCanonicalQueryString(query);
    const [canonicalHeaders, signedHeaders] = this.getCanonicalHeaders(headers);
    const hashedPayload = crypto.createHash('sha256').update(body).digest('hex');

    const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;

    const shortDate = date.slice(0, 8);
    const credentialScope = `${shortDate}/${this.region}/${this.service}/jdcloud2_request`;
    const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
    const stringToSign = `${this.algorithm}\n${date}\n${credentialScope}\n${hashedCanonicalRequest}`;

    const kDate = crypto.createHmac('sha256', `JDCLOUD2${this.accessKeySecret}`).update(shortDate).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(this.region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(this.service).digest();
    const kSigning = crypto.createHmac('sha256', kService).update('jdcloud2_request').digest();
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    const credential = `${this.accessKeyId}/${credentialScope}`;
    return `${this.algorithm} Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  }

  async request<T>(method: string, action: string, params: Dict = {}): Promise<T> {
    const path = `/${this.version}/regions/${this.region}${action}`;
    const date = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';

    let query: Record<string, string> = {};
    let body = '';

    if (method === 'GET' || method === 'DELETE') {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          query[key] = String(value);
        }
      }
    } else {
      body = JSON.stringify(params);
    }

    const headers: Record<string, string> = {
      Host: this.endpoint,
      'x-jdcloud-algorithm': this.algorithm,
      'x-jdcloud-date': date,
      'x-jdcloud-nonce': uuid(),
    };

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const authorization = this.generateSign(method, path, query, headers, body, date);
    headers['authorization'] = authorization;

    let url = `https://${this.endpoint}${path}`;
    if (Object.keys(query).length > 0) {
      url += '?' + this.getCanonicalQueryString(query);
    }

    const res = await fetchWithFallback(url, { method, headers, body: body || undefined }, this.useProxy, 'JDCloud');
    const data = (await res.json()) as Dict;

    if (res.status !== 200) {
      const errorMsg = safeString((data.error as Dict)?.message) || `Jdcloud request failed: ${res.status}`;
      throw new Error(errorMsg);
    }

    return (data.result || data) as T;
  }
}

export class JdcloudAdapter extends BaseAdapter {
  private config: JdcloudConfig;
  private client: JdcloudClient;
  private domainInfo: Dict | null = null;

  constructor(config: Record<string, string>) {
    super();
    this.config = {
      AccessKeyId: safeString(config.AccessKeyId),
      AccessKeySecret: safeString(config.AccessKeySecret),
      domain: safeString(config.domain),
      domainId: safeString(config.zoneId),
      useProxy: !!config.useProxy,
    };
    this.client = new JdcloudClient(this.config.AccessKeyId, this.config.AccessKeySecret, this.config.useProxy);
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
      const data = await this.client.request<{ dataList: Array<{ id: string; domainName: string }>; totalCount: number }>('GET', '/domain', { pageNumber: page, pageSize, domainName: keyword });
      let list = (data.dataList || []).map((row) => ({
        Domain: row.domainName,
        ThirdId: row.id,
        RecordCount: 0,
      }));
      if (keyword) {
        list = list.filter((d) => d.Domain.toLowerCase().includes(keyword.toLowerCase()));
      }
      return { total: data.totalCount || list.length, list };
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
    return resolveDomainIdHelper(this.config, this.getDomainList.bind(this), 'JDCloud');
  }

  async getDomainRecords(
    page = 1,
    pageSize = 20,
    keyword?: string,
    subdomain?: string,
    _value?: string,
    _type?: string,
    _line?: string,
    _status?: number
  ): Promise<PageResult<DnsRecord>> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        this.error = this.error || '读取记录失败：未解析到域名或上游返回空结果';
        return { total: 0, list: [] };
      }

      if (pageSize > 99) pageSize = 99;
      const params: Dict = { pageNumber: page, pageSize };

      if (subdomain) {
        params.search = subdomain.toLowerCase();
      } else if (keyword) {
        params.search = keyword;
      }

      const data = await this.client.request<{ dataList: Array<Dict>; totalCount: number }>('GET', `/domain/${domainId}/ResourceRecord`, params);
      let list = (data.dataList || []).map((row) => this.mapRecord(row));

      if (subdomain) {
        list = list.filter((r) => r.Name.toLowerCase() === subdomain.toLowerCase());
      }

      return { total: data.totalCount || list.length, list };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return { total: 0, list: [] };
    }
  }

  async getDomainRecordInfo(_recordId: string): Promise<DnsRecord | null> {
    return null;
  }

  async addDomainRecord(
    name: string,
    type: string,
    value: string,
    line?: string,
    ttl = 600,
    mx = 1,
    weight?: number,
    _remark?: string
  ): Promise<string | null> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        return null;
      }

      const reqParams: Dict = {
        hostRecord: name,
        type: this.convertType(type),
        hostValue: value,
        viewValue: toNumber(normalizeLine(line, DEFAULT_LINE), 0),
        ttl: toNumber(ttl, 600),
      };

      if (type === 'MX') {
        reqParams.mxPriority = toNumber(mx, 1);
      }
      if (weight && weight > 0) {
        reqParams.weight = toNumber(weight, 0);
      }
      if (type === 'SRV') {
        const values = value.split(' ');
        reqParams.mxPriority = toNumber(values[0], 0);
        reqParams.weight = toNumber(values[1], 0);
        reqParams.port = toNumber(values[2], 0);
        reqParams.hostValue = values[3] || '';
      }

      const params: Dict = { req: reqParams };

      const data = await this.client.request<{ dataList: { id: string } }>('POST', `/domain/${domainId}/ResourceRecord`, params);
      return data.dataList?.id || null;
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
    _remark?: string
  ): Promise<boolean> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        return false;
      }

      const reqParams: Dict = {
        domainName: this.config.domain,
        hostRecord: name,
        type: this.convertType(type),
        hostValue: value,
        viewValue: toNumber(normalizeLine(line, DEFAULT_LINE), 0),
        ttl: toNumber(ttl, 600),
      };

      if (type === 'MX') {
        reqParams.mxPriority = toNumber(mx, 1);
      }
      if (weight && weight > 0) {
        reqParams.weight = toNumber(weight, 0);
      }
      if (type === 'SRV') {
        const values = value.split(' ');
        reqParams.mxPriority = toNumber(values[0], 0);
        reqParams.weight = toNumber(values[1], 0);
        reqParams.port = toNumber(values[2], 0);
        reqParams.hostValue = values[3] || '';
      }
      const params: Dict = { req: reqParams };

      await this.client.request('PUT', `/domain/${domainId}/ResourceRecord/${recordId}`, params);
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

      await this.client.request('DELETE', `/domain/${domainId}/ResourceRecord/${recordId}`);
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async setDomainRecordStatus(recordId: string, status: number): Promise<boolean> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        return false;
      }

      await this.client.request('PUT', `/domain/${domainId}/ResourceRecord/${recordId}/status`, { action: status === 1 ? 'enable' : 'disable' });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    try {
      const domainInfo = await this.getDomainInfo();
      if (!domainInfo) {
        this.error = '线路查询失败（jdcloud）';
        throw new Error(this.error);
      }

      const domainId = await this.resolveDomainId();
      if (!domainId) {
        this.error = '线路查询失败（jdcloud）';
        throw new Error(this.error);
      }

      const packId = domainInfo.packId;
      const data = await this.client.request<{ data: Array<Dict> }>('GET', `/domain/${domainId}/viewTree`, { packId, viewId: '0' });
      const list: Array<{ id: string; name: string }> = [];
      this.processLineList(list, data.data || [], null);
      return list;
    } catch (e) {
      this.error = '线路查询失败（jdcloud）';
        throw new Error(this.error);
    }
  }

  async getMinTTL(): Promise<number> {
    return 60;
  }

  async addDomain(domain: string): Promise<boolean> {
    try {
      await this.client.request('POST', '/domain', { packId: 0, domainName: domain });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  private async getDomainInfo(): Promise<Dict | null> {
    if (this.domainInfo) {
      return this.domainInfo;
    }
    if (!this.config.domainId) {
      return null;
    }
    try {
      const data = await this.client.request<{ dataList: Dict[] }>('GET', '/domain', { domainId: this.config.domainId });
      if (data.dataList && data.dataList.length > 0) {
        this.domainInfo = data.dataList[0];
        return this.domainInfo;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  private convertType(type: string): string {
    const convertDict: Record<string, string> = {
      REDIRECT_URL: 'EXPLICIT_URL',
      FORWARD_URL: 'IMPLICIT_URL',
    };
    return convertDict[type] || type;
  }

  private processLineList(list: Array<{ id: string; name: string }>, lineList: Array<Dict>, parent: string | null): void {
    for (const row of lineList) {
      if (row.disabled) continue;
      const value = safeString(row.value);
      if (!list.find((item) => item.id === value)) {
        list.push({ id: value, name: safeString(row.label) });
        if (!row.leaf && row.children) {
          this.processLineList(list, row.children as Array<Dict>, value);
        }
      }
    }
  }


  private mapRecord(row: Dict): DnsRecord {
    let value = safeString(row.hostValue);
    if (row.type === 'SRV') {
      value = `${row.mxPriority} ${row.weight} ${row.port} ${row.hostValue}`;
    }

    const viewValue = Array.isArray(row.viewValue) ? row.viewValue : [row.viewValue];

    return {
      RecordId: safeString(row.id),
      Domain: this.config.domain || '',
      Name: safeString(row.hostRecord),
      Type: safeString(row.type),
      Value: value,
      Line: String(viewValue[viewValue.length - 1] || '0'),
      TTL: toNumber(row.ttl, 600),
      MX: row.mxPriority ? toNumber(row.mxPriority, 0) : 0,
      Status: row.resolvingStatus === '2' ? 1 : 0,
      Weight: row.weight ? toNumber(row.weight, 0) : undefined,
      Remark: undefined,
      UpdateTime: row.updateTime ? new Date(row.updateTime as number).toISOString() : undefined,
    };
  }
}
