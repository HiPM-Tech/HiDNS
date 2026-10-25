import { createProviderAdapterLogger, DnsAdapter, DnsRecord, DomainInfo, PageResult, BaseAdapter, Dict, resolveDomainIdHelper, safeString, toNumber, fetchWithFallback, resolveProviderLine, normalizeLine } from '../internal';
import crypto from 'node:crypto';
export const DEFAULT_LINE = '0';

const log = createProviderAdapterLogger('Huoshan');
interface HuoshanConfig {
  AccessKeyId: string;
  SecretAccessKey: string;
  domain?: string;
  domainId?: string;
  useProxy?: boolean;
}

class VolcengineClient {
  private endpoint = 'open.volcengineapi.com';
  private service = 'DNS';
  private version = '2018-08-01';
  private region = 'cn-north-1';

  constructor(
    private accessKeyId: string,
    private secretAccessKey: string,
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
    timestamp: number
  ): string {
    const algorithm = 'HMAC-SHA256';
    const date = new Date(timestamp * 1000).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    const shortDate = date.slice(0, 8);

    const canonicalUri = path.endsWith('/') ? path : path + '/';
    const canonicalQuery = this.getCanonicalQueryString(query);
    const [canonicalHeaders, signedHeaders] = this.getCanonicalHeaders(headers);
    const hashedPayload = crypto.createHash('sha256').update(body).digest('hex');

    const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;

    const credentialScope = `${shortDate}/${this.region}/${this.service}/request`;
    const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
    const stringToSign = `${algorithm}\n${date}\n${credentialScope}\n${hashedCanonicalRequest}`;

    const kDate = crypto.createHmac('sha256', this.secretAccessKey).update(shortDate).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(this.region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(this.service).digest();
    const kSigning = crypto.createHmac('sha256', kService).update('request').digest();
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    return `${algorithm} Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  }

  async request<T>(method: string, action: string, params: Dict = {}): Promise<T> {
    const query: Record<string, string> = {
      Action: action,
      Version: this.version,
    };

    let body = '';
    if (method === 'GET') {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          query[key] = String(value);
        }
      }
    } else {
      body = JSON.stringify(params);
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = {
      Host: this.endpoint,
      'X-Date': new Date(timestamp * 1000).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z',
    };
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const authorization = this.generateSign(method, '/', query, headers, body, timestamp);
    headers['Authorization'] = authorization;

    const url = `https://${this.endpoint}/?${this.getCanonicalQueryString(query)}`;
    const res = await fetchWithFallback(url, { method, headers, body: body || undefined }, this.useProxy, 'Huoshan');
    const data = (await res.json()) as Dict;

    if (res.status !== 200) {
      const errorMsg = safeString(((data.ResponseMetadata as Dict)?.Error as Dict)?.MessageCN) ||
        safeString(((data.ResponseMetadata as Dict)?.Error as Dict)?.Message) ||
        safeString(data.Message) ||
        safeString(data.message) ||
        `Volcengine request failed: ${res.status}`;
      throw new Error(errorMsg);
    }

    if ((data.ResponseMetadata as Dict)?.Error) {
      throw new Error(safeString(((data.ResponseMetadata as Dict).Error as Dict)?.MessageCN) || safeString(((data.ResponseMetadata as Dict).Error as Dict)?.Message));
    }

    return (data.Result || true) as T;
  }
}

const tradeCodeList: Record<string, { level: number; name: string; ttl: number }> = {
  free_inner: { level: 1, name: '免费版', ttl: 600 },
  professional_inner: { level: 2, name: '专业版', ttl: 300 },
  enterprise_inner: { level: 3, name: '企业版', ttl: 60 },
  ultimate_inner: { level: 4, name: '旗舰版', ttl: 1 },
  ultimate_exclusive_inner: { level: 5, name: '尊享版', ttl: 1 },
};

export class HuoshanAdapter extends BaseAdapter {
  private config: HuoshanConfig;
  private client: VolcengineClient;
  private domainInfo: Dict | null = null;

  constructor(config: Record<string, string>) {
    super();
    this.config = {
      AccessKeyId: safeString(config.AccessKeyId),
      SecretAccessKey: safeString(config.SecretAccessKey),
      domain: safeString(config.domain),
      domainId: safeString(config.zoneId),
      useProxy: !!config.useProxy,
    };
    this.client = new VolcengineClient(this.config.AccessKeyId, this.config.SecretAccessKey, this.config.useProxy);
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
      const data = await this.client.request<{ Zones: Array<{ ZID: string; ZoneName: string; RecordCount: number }>; Total: number }>('GET', 'ListZones', { PageNumber: page, PageSize: pageSize, Key: keyword });
      let list = (data.Zones || []).map((row) => ({
        Domain: row.ZoneName,
        ThirdId: row.ZID,
        RecordCount: row.RecordCount,
      }));
      if (keyword) {
        list = list.filter((d) => d.Domain.toLowerCase().includes(keyword.toLowerCase()));
      }
      return { total: data.Total || list.length, list };
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
    return resolveDomainIdHelper(this.config, this.getDomainList.bind(this), 'Huoshan');
  }

  async getDomainRecords(
    page = 1,
    pageSize = 20,
    keyword?: string,
    subdomain?: string,
    value?: string,
    type?: string,
    line?: string,
    _status?: number
  ): Promise<PageResult<DnsRecord>> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        this.error = this.error || '读取记录失败：未解析到域名或上游返回空结果';
        return { total: 0, list: [] };
      }

      const params: Dict = { ZID: toNumber(domainId, 0), PageNumber: page, PageSize: pageSize, SearchOrder: 'desc' };

      if (subdomain || type || line || value) {
        params.Host = subdomain;
        params.Value = value;
        params.Type = type;
        params.Line = line;
        params.SearchMode = 'exact';
      } else if (keyword) {
        params.Host = keyword;
      }

      const data = await this.client.request<{ Records: Array<Dict>; TotalCount: number }>('GET', 'ListRecords', params);
      const list = (data.Records || []).map((row) => this.mapRecord(row));
      return { total: data.TotalCount || list.length, list };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return { total: 0, list: [] };
    }
  }

  async getDomainRecordInfo(recordId: string): Promise<DnsRecord | null> {
    try {
      const data = await this.client.request<Dict>('GET', 'QueryRecord', { RecordID: recordId });
      if (data.name === data.zone_name) {
        data.name = '@';
      }
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
    mx = 1,
    weight?: number,
    remark?: string
  ): Promise<string | null> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        return null;
      }

      const params: Dict = {
        ZID: toNumber(domainId, 0),
        Host: name,
        Type: this.convertType(type),
        Value: type === 'MX' ? `${mx} ${value}` : value,
        Line: normalizeLine(line, DEFAULT_LINE),
        TTL: toNumber(ttl, 600),
        Remark: remark,
      };

      if (weight && weight > 0) {
        params.Weight = weight;
      }

      const data = await this.client.request<{ RecordID: string }>('POST', 'CreateRecord', params);
      return data.RecordID || null;
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
      const params: Dict = {
        RecordID: recordId,
        Host: name,
        Type: this.convertType(type),
        Value: type === 'MX' ? `${mx} ${value}` : value,
        Line: normalizeLine(line, DEFAULT_LINE),
        TTL: toNumber(ttl, 600),
        Remark: remark,
      };

      if (weight && weight > 0) {
        params.Weight = weight;
      }

      await this.client.request('POST', 'UpdateRecord', params);
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    try {
      await this.client.request('POST', 'DeleteRecord', { RecordID: recordId });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async setDomainRecordStatus(recordId: string, status: number): Promise<boolean> {
    try {
      await this.client.request('POST', 'UpdateRecordStatus', { RecordID: recordId, Enable: status === 1 });
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
        this.error = '线路查询失败（huoshan）';
        throw new Error(this.error);
      }

      const tradeInfo = this.getTradeInfo(safeString(domainInfo.TradeCode));
      const level = tradeInfo.level;

      const data = await this.client.request<{ Lines: Array<{ Value: string; Name: string; Level: number; FatherValue?: string }> }>('GET', 'ListLines', {});
      const list: Array<{ id: string; name: string }> = [{ id: '0', name: '默认' }];

      for (const row of data.Lines || []) {
        if (row.Value === 'default') continue;
        if (row.Level > level) continue;
        list.push({ id: row.Value, name: row.Name });
      }

      const customData = await this.client.request<{ TotalCount: number; CustomerLines: Array<{ Line: string; NameCN: string }> }>('GET', 'ListCustomLines', {});
      if (customData.TotalCount > 0) {
        for (const row of customData.CustomerLines) {
          list.push({ id: row.Line, name: row.NameCN });
        }
      }

      return list;
    } catch (e) {
      this.error = '线路查询失败（huoshan）';
        throw new Error(this.error);
    }
  }

  async getMinTTL(): Promise<number> {
    try {
      const domainInfo = await this.getDomainInfo();
      if (domainInfo) {
        return this.getTradeInfo(safeString(domainInfo.TradeCode)).ttl;
      }
      return 600;
    } catch (e) {
      return 600;
    }
  }

  async addDomain(domain: string): Promise<boolean> {
    try {
      await this.client.request('POST', 'CreateZone', { ZoneName: domain });
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
    const domainId = await this.resolveDomainId();
    if (!domainId) {
      return null;
    }
    try {
      const data = await this.client.request<Dict>('GET', 'QueryZone', { ZID: toNumber(domainId, 0) });
      this.domainInfo = data;
      return data;
    } catch (e) {
      return null;
    }
  }

  private convertType(type: string): string {
    return type;
  }

  private getTradeInfo(tradeCode: string): { level: number; name: string; ttl: number } {
    return tradeCodeList[tradeCode] || tradeCodeList.free_inner;
  }


  private mapRecord(row: Dict): DnsRecord {
    let value = safeString(row.Value);
    let mx: number | undefined;
    if (row.Type === 'MX') {
      const parts = value.split(' ', 2);
      mx = toNumber(parts[0], 0);
      value = parts[1] || value;
    }

    return {
      RecordId: safeString(row.RecordID),
      Domain: this.config.domain || '',
      Name: safeString(row.Host),
      Type: safeString(row.Type),
      Value: value,
      Line: safeString(row.Line) || '0',
      TTL: toNumber(row.TTL, 600),
      MX: mx || 0,
      Status: row.Enable ? 1 : 0,
      Weight: row.Weight ? toNumber(row.Weight, 0) : undefined,
      Remark: safeString(row.Remark) || undefined,
      UpdateTime: safeString(row.UpdatedAt) || undefined,
    };
  }
}
