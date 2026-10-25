import { createProviderAdapterLogger, DnsAdapter, DnsRecord, DomainInfo, PageResult, asArray, BaseAdapter, Dict, normalizeRrName, resolveDomainIdHelper, safeString, toNumber, toRecordStatus, uuid, fetchWithFallback } from '../internal';
import crypto from 'node:crypto';
export const DEFAULT_LINE = '0';

const log = createProviderAdapterLogger('AliyunESA');
class AliyunEsaRpcClient {
  private useProxy: boolean;
  constructor(
    private readonly endpoint: string,
    private readonly accessKeyId: string,
    private readonly accessKeySecret: string,
    private readonly version: string = '2024-09-10',
    useProxy: boolean = false
  ) {
    this.useProxy = useProxy;
  }

  private percentEncode(value: string): string {
    return encodeURIComponent(value)
      .replace(/\+/g, '%20')
      .replace(/\*/g, '%2A')
      .replace(/%7E/g, '~');
  }

  private buildSignedQuery(action: string, params: Record<string, unknown>): URLSearchParams {
    const publicParams: Record<string, string> = {
      Action: action,
      Format: 'JSON',
      Version: this.version,
      AccessKeyId: this.accessKeyId,
      SignatureMethod: 'HMAC-SHA1',
      Timestamp: new Date().toISOString(),
      SignatureVersion: '1.0',
      SignatureNonce: uuid(),
    };

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      publicParams[key] = String(value);
    }

    const sortedKeys = Object.keys(publicParams).sort();
    const canonicalized = sortedKeys
      .map((key) => `${this.percentEncode(key)}=${this.percentEncode(publicParams[key])}`)
      .join('&');

    const stringToSign = `GET&%2F&${this.percentEncode(canonicalized)}`;
    const signature = crypto
      .createHmac('sha1', `${this.accessKeySecret}&`)
      .update(stringToSign)
      .digest('base64');

    const search = new URLSearchParams(publicParams);
    search.set('Signature', signature);
    return search;
  }

  async call<T = Dict>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    const query = this.buildSignedQuery(action, params);
    const url = `${this.endpoint}?${query.toString()}`;
    const res = await fetchWithFallback(url, { method: 'GET' }, this.useProxy, 'AliyunESA');
    const data = (await res.json()) as Dict;
    if (!res.ok || data.Code) {
      const err = safeString(data.Message) || safeString(data.Code) || `Aliyun ESA action ${action} failed`;
      throw new Error(err);
    }
    return data as T;
  }
}

interface AliyunEsaConfig {
  AccessKeyId: string;
  AccessKeySecret: string;
  region?: string;
  domain?: string;
  domainId?: string;
  useProxy?: boolean;
}

export class AliyunesaAdapter extends BaseAdapter {
  private config: AliyunEsaConfig;
  private client: AliyunEsaRpcClient;

  constructor(config: Record<string, string>) {
    super();
    this.config = {
      AccessKeyId: safeString(config.AccessKeyId),
      AccessKeySecret: safeString(config.AccessKeySecret),
      region: safeString(config.region) || 'cn-hangzhou',
      domain: safeString(config.domain),
      domainId: safeString(config.zoneId),
      useProxy: !!config.useProxy,
    };
    const endpoint = `https://esa.${this.config.region}.aliyuncs.com/`;
    this.client = new AliyunEsaRpcClient(endpoint, this.config.AccessKeyId, this.config.AccessKeySecret, '2024-09-10', this.config.useProxy);
  }

  async check(): Promise<boolean> {
    try {
      await this.client.call('ListSites', { PageSize: 1, PageNumber: 1, AccessType: 'NS' });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async getDomainList(keyword?: string, page = 1, pageSize = 20): Promise<PageResult<DomainInfo>> {
    try {
      const data = await this.client.call<Dict>('ListSites', {
        PageNumber: page,
        PageSize: pageSize,
        SiteName: keyword,
        AccessType: 'NS',
      });
      const list = asArray<Dict>(data.Sites).map((item) => ({
        Domain: safeString(item.SiteName),
        ThirdId: safeString(item.SiteId),
        RecordCount: 0,
      }));
      return { total: toNumber(data.TotalCount, list.length), list };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      log.error('getDomainList failed', this.error);
      return { total: 0, list: [] };
    }
  }

  /**
   * 根据域名查找 Domain ID (Site ID)
   * 当 config.domainId 未设置时，尝试通过域名搜索获取
   */
  private async resolveDomainId(): Promise<string | null> {
    return resolveDomainIdHelper(this.config, this.getDomainList.bind(this), 'Aliyunesa');
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
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        this.error = this.error || '读取记录失败：未解析到域名或上游返回空结果';
        return { total: 0, list: [] };
      }

      const params: Record<string, unknown> = {
        Action: 'ListRecords',
        SiteId: domainId,
        PageNumber: page,
        PageSize: pageSize,
      };

      if (subdomain) {
        const recordName = subdomain === '@' ? this.config.domain : `${subdomain}.${this.config.domain}`;
        params.RecordName = recordName;
      } else if (keyword) {
        const recordName = keyword === '@' ? this.config.domain : `${keyword}.${this.config.domain}`;
        params.RecordName = recordName;
      }

      if (type) {
        if (type === 'A' || type === 'AAAA') {
          params.Type = 'A/AAAA';
        } else {
          params.Type = type;
        }
      }

      if (line) {
        params.Proxied = line === '1' ? 'true' : 'false';
      }

      const data = await this.client.call<Dict>('ListRecords', params);
      const list = asArray<Dict>(data.Records).map((row) => this.mapRecord(row));
      return { total: toNumber(data.TotalCount, list.length), list };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return { total: 0, list: [] };
    }
  }

  async getDomainRecordInfo(recordId: string): Promise<DnsRecord | null> {
    try {
      const data = await this.client.call<Dict>('GetRecord', { RecordId: recordId });
      return this.mapRecord(data.RecordModel as Dict);
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
    remark?: string
  ): Promise<string | null> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        return null;
      }

      const recordName = name === '@' ? this.config.domain : `${name}.${this.config.domain}`;
      const recordType = type === 'A' || type === 'AAAA' ? 'A/AAAA' : type;

      let data: Dict = { Value: value };
      if (type === 'CAA') {
        const parts = value.split(' ', 3);
        data = { Flag: parseInt(parts[0]), Tag: parts[1], Value: parts[2] };
      } else if (type === 'SRV') {
        const parts = value.split(' ', 4);
        data = {
          Priority: parseInt(parts[0]),
          Weight: parseInt(parts[1]),
          Port: parseInt(parts[2]),
          Value: parts[3],
        };
      } else if (type === 'MX') {
        data.Priority = mx;
      }

      const params: Record<string, unknown> = {
        Action: 'CreateRecord',
        SiteId: domainId,
        RecordName: recordName,
        Type: recordType,
        Proxied: line === '1' ? 'true' : 'false',
        Ttl: ttl,
        Data: JSON.stringify(data),
      };

      if (remark) {
        params.Comment = remark;
      }

      if (line === '1') {
        params.BizName = 'web';
      }

      const result = await this.client.call<Dict>('CreateRecord', params);
      return safeString(result.RecordId) || null;
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
    remark?: string
  ): Promise<boolean> {
    try {
      const recordName = name === '@' ? this.config.domain : `${name}.${this.config.domain}`;
      const recordType = type === 'A' || type === 'AAAA' ? 'A/AAAA' : type;

      let data: Dict = { Value: value };
      if (type === 'CAA') {
        const parts = value.split(' ', 3);
        data = { Flag: parseInt(parts[0]), Tag: parts[1], Value: parts[2] };
      } else if (type === 'SRV') {
        const parts = value.split(' ', 4);
        data = {
          Priority: parseInt(parts[0]),
          Weight: parseInt(parts[1]),
          Port: parseInt(parts[2]),
          Value: parts[3],
        };
      } else if (type === 'MX') {
        data.Priority = mx;
      }

      const params: Record<string, unknown> = {
        Action: 'UpdateRecord',
        RecordId: recordId,
        Type: recordType,
        Proxied: line === '1' ? 'true' : 'false',
        Ttl: ttl,
        Data: JSON.stringify(data),
      };

      if (remark) {
        params.Comment = remark;
      }

      if (line === '1') {
        params.BizName = 'web';
      }

      await this.client.call('UpdateRecord', params);
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    try {
      await this.client.call('DeleteRecord', { RecordId: recordId });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async setDomainRecordStatus(_recordId: string, _status: number): Promise<boolean> {
    // Aliyun ESA does not support record status toggle
    this.error = 'Aliyun ESA does not support record status toggle';
    return false;
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    return [{ id: '0', name: '默认' }];
  }

  async getMinTTL(): Promise<number> {
    return 1;
  }

  async addDomain(_domain: string): Promise<boolean> {
    this.error = 'Aliyun ESA does not support domain registration via API';
    return false;
  }

  private mapRecord(row: Dict): DnsRecord {
    const domain = this.config.domain || '';
    let name = '';
    const recordName = safeString(row.RecordName);
    if (recordName === domain) {
      name = '@';
    } else if (recordName.endsWith(`.${domain}`)) {
      name = recordName.slice(0, -(domain.length + 1));
    } else {
      name = recordName;
    }

    let value = '';
    const data = row.Data as Dict || {};
    if (row.RecordType === 'CAA') {
      value = `${data.Flag} ${data.Tag} ${data.Value}`;
    } else if (row.RecordType === 'SRV') {
      value = `${data.Priority} ${data.Weight} ${data.Port} ${data.Value}`;
    } else {
      value = safeString(data.Value);
    }

    let recordType = safeString(row.RecordType);
    if (recordType === 'A/AAAA') {
      // Determine if it's A or AAAA based on value
      if (value.includes(':')) {
        recordType = 'AAAA';
      } else {
        recordType = 'A';
      }
    }

    return {
      RecordId: safeString(row.RecordId),
      Domain: domain,
      Name: name,
      Type: recordType,
      Value: value,
      Line: row.Proxied ? '1' : '0',
      TTL: toNumber(row.Ttl, 600),
      MX: data.Priority ? toNumber(data.Priority, 0) : 0,
      Status: 1,
      Weight: undefined,
      Remark: safeString(row.Comment) || undefined,
      UpdateTime: row.UpdateTime ? new Date(row.UpdateTime as string).toISOString() : undefined,
    };
  }
}
