import { createProviderAdapterLogger, DnsAdapter, DnsRecord, DomainInfo, PageResult, fetchWithFallback, resolveDomainIdHelper } from '../internal';
import crypto from 'crypto';
export const DEFAULT_LINE = '默认';

const log = createProviderAdapterLogger('CaihongDns');
interface CaihongDnsConfig {
  baseUrl: string;
  uid: string;
  apiKey: string;
  domain?: string;
  domainId?: string;
  useProxy?: boolean;
}

interface CaihongDnsResponse<T> {
  code?: number;
  data?: T;
  msg?: string;
  total?: number;
  rows?: T;
}

interface CaihongDnsDomain {
  id: number;
  name: string;
  thirdid?: string;
  recordcount?: number;
  type?: string;
  typename?: string;
}

interface CaihongDnsRecord {
  RecordId: string;
  Domain: string;
  Name: string;
  Type: string;
  Value: string;
  Line: string;
  LineName?: string;
  TTL: number;
  MX: number | null;
  Weight: number;
  Status: string;
  Remark: string | null;
  UpdateTime: string | null;
}

export class CaihongDnsAdapter implements DnsAdapter {
  private config: CaihongDnsConfig;
  private error: string = '';

  constructor(config: Record<string, string>) {
    this.config = {
      baseUrl: config.baseUrl || '',
      uid: config.uid || '',
      apiKey: config.apiKey || '',
      domain: config.domain,
      domainId: config.domainId || config.zoneId, // Support both domainId and zoneId
      useProxy: !!config.useProxy,
    };
  }

  /**
   * 生成API签名
   * sign = md5(uid + timestamp + apikey)
   */
  private generateSign(timestamp: number): string {
    return crypto.createHash('md5').update(`${this.config.uid}${timestamp}${this.config.apiKey}`).digest('hex');
  }

  /**
   * 获取认证参数
   */
  private getAuthParams(): Record<string, string | number> {
    const timestamp = Math.floor(Date.now() / 1000);
    return {
      uid: parseInt(this.config.uid),
      timestamp,
      sign: this.generateSign(timestamp),
    };
  }

  private async request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<CaihongDnsResponse<T>> {
    // Ensure baseUrl doesn't end with /api and path starts with /
    const baseUrl = this.config.baseUrl.replace(/\/api\/?$/, '');
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${baseUrl}/api${normalizedPath}`;
    const authParams = this.getAuthParams();

    log.sub('API').tag('REQUEST').debug('Provider request', { method: method, url: url, params: { ...body, ...authParams, sign: '***' } });

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
      };

      const params = new URLSearchParams();
      // Add auth params first
      Object.entries(authParams).forEach(([key, value]) => {
        params.append(key, String(value));
      });
      // Add body params
      if (body) {
        Object.entries(body).forEach(([key, value]) => {
          if (value !== undefined && value !== null) {
            params.append(key, String(value));
          }
        });
      }
      const requestBody = params.toString();

      const res = await fetchWithFallback(url, {
        method,
        headers,
        body: requestBody,
      }, this.config.useProxy, 'CaihongDns');

      // Get response text first to handle non-JSON responses
      const responseText = await res.text();

      let data: CaihongDnsResponse<T>;
      try {
        // Try to parse as JSON
        data = JSON.parse(responseText) as CaihongDnsResponse<T>;
      } catch (parseError) {
        // If JSON parsing fails, return error with raw response
        const errorMsg = `Invalid JSON response: ${responseText.substring(0, 200)}`;
        log.sub('API').tag('ERROR').error('Provider error', [{ message: errorMsg }]);
        return { code: -1, msg: errorMsg };
      }

      // Check if response has error code
      const hasError = data.code !== undefined && data.code !== 0;
      log.sub('API').tag('RESPONSE').debug('Provider response', { status: res.status, success: !hasError, data: { code: data.code, msg: data.msg, hasData: data.rows !== undefined } });

      if (hasError) {
        this.error = data.msg || 'API error';
        log.sub('API').tag('ERROR').error('Provider error', [{ message: this.error }]);
      }

      return data;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      log.sub('API').tag('ERROR').error('Provider error', [{ message: this.error }]);
      return { code: -1, msg: this.error };
    }
  }

  async check(): Promise<boolean> {
    try {
      // 尝试获取域名列表来验证连接
      const res = await this.request<CaihongDnsDomain[]>('POST', '/domain', { offset: 0, limit: 1 });
      // Success if no error code and has rows/total
      return (res.code === undefined || res.code === 0) && res.rows !== undefined;
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
      const offset = (page - 1) * pageSize;
      const body: Record<string, unknown> = { offset, limit: pageSize };
      if (keyword) body.kw = keyword;

      const res = await this.request<CaihongDnsDomain[]>('POST', '/domain', body);

      // Check for error
      if (res.code !== undefined && res.code !== 0) {
        this.error = this.error || `读取域名列表失败：code=${res.code}`;
        return { total: 0, list: [] };
      }

      const rows: CaihongDnsDomain[] | undefined = res.rows;
      if (!rows || rows.length === 0) {
        return { total: 0, list: [] };
      }

      return {
        total: res.total || 0,
        list: rows.map((d) => ({
          Domain: d.name,
          ThirdId: String(d.id),
          RecordCount: d.recordcount || 0,
        })),
      };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return { total: 0, list: [] };
    }
  }

  /**
   * 根据域名查找 Domain ID
   * 当 config.domainId 未设置时，尝试通过域名搜索获取
   */
  private async resolveDomainId(): Promise<string | null> {
    return resolveDomainIdHelper(this.config, this.getDomainList.bind(this), 'CaihongDns');
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

      const offset = (page - 1) * pageSize;
      const body: Record<string, unknown> = {
        offset,
        limit: pageSize
      };
      if (keyword) body.keyword = keyword;
      if (subdomain) body.subdomain = subdomain;
      if (value) body.value = value;
      if (type) body.type = type;
      if (status !== undefined) body.status = String(status);

      const res = await this.request<CaihongDnsRecord[]>('POST', `/record/data/${domainId}`, body);

      // Check for error
      if (res.code !== undefined && res.code !== 0) {
        this.error = this.error || '读取记录失败：未解析到域名或上游返回空结果';
      return { total: 0, list: [] };
      }

      const rows: CaihongDnsRecord[] | undefined = res.rows;
      if (!rows || rows.length === 0) {
        this.error = this.error || '读取记录失败：未解析到域名或上游返回空结果';
      return { total: 0, list: [] };
      }

      return {
        total: res.total || 0,
        list: rows.map((r) => this.mapRecord(r)),
      };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return { total: 0, list: [] };
    }
  }

  private mapRecord(r: CaihongDnsRecord): DnsRecord {
    return {
      RecordId: r.RecordId,
      Domain: r.Domain || this.config.domain || '',
      Name: r.Name,
      Type: r.Type,
      Value: r.Value,
      Line: r.Line,
      TTL: r.TTL,
      MX: r.MX === null ? 0 : r.MX,
      Status: parseInt(r.Status, 10) || 0,
      Weight: r.Weight,
      Remark: r.Remark || undefined,
      UpdateTime: r.UpdateTime || undefined,
    };
  }

  async getDomainRecordInfo(recordId: string): Promise<DnsRecord | null> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        this.error = 'Domain ID not set';
        return null;
      }

      // 从列表中查找
      const res = await this.request<CaihongDnsRecord[]>('POST', `/record/data/${domainId}`, {
        offset: 0,
        limit: 1000,
      });

      if ((res.code !== undefined && res.code !== 0) || !res.rows || res.rows.length === 0) {
        return null;
      }

      const rows: CaihongDnsRecord[] = res.rows;
      const record = rows.find((r) => r.RecordId === recordId);
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

      const res = await this.request<null>('POST', `/record/add/${domainId}`, body);

      if (res.code !== undefined && res.code !== 0) {
        return null;
      }

      // 彩虹DNS聚合不返回记录ID，需要查询获取
      const records = await this.getDomainRecords(1, 100, undefined, name, value, type);
      const record = records.list.find((r) => r.Name === name && r.Type === type && r.Value === value);
      return record?.RecordId || null;
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
        recordid: recordId,
        name,
        type,
        value,
        ttl,
      };
      if (line) body.line = line;
      if (type === 'MX') body.mx = mx;
      if (weight !== undefined) body.weight = weight;
      if (remark) body.remark = remark;

      const res = await this.request<null>('POST', `/record/update/${domainId}`, body);
      return res.code === undefined || res.code === 0;
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

      const res = await this.request<null>('POST', `/record/delete/${domainId}`, {
        recordid: recordId,
      });
      return res.code === undefined || res.code === 0;
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

      const res = await this.request<null>('POST', `/record/status/${domainId}`, {
        recordid: recordId,
        status: status === 1 ? '1' : '0',
      });
      return res.code === undefined || res.code === 0;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    // 彩虹DNS聚合的线路列表
    return [
      { id: '默认', name: '默认' },
      { id: '电信', name: '电信' },
      { id: '联通', name: '联通' },
      { id: '移动', name: '移动' },
      { id: '教育网', name: '教育网' },
      { id: '境外', name: '境外' },
    ];
  }

  async getMinTTL(): Promise<number> {
    return 60;
  }

  async addDomain(domain: string): Promise<boolean> {
    // 彩虹DNS聚合作为提供商，不支持通过 API 添加域名到对方系统
    this.error = 'Adding domains is not supported for CaihongDns provider';
    return false;
  }
}
