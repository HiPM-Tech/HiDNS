import {createProviderAdapterLogger, DnsRecord, DomainInfo, PageResult, BaseAdapter, safeString, toNumber, Dict, fetchWithFallback, resolveCreatedRecordId } from '../internal';

const log = createProviderAdapterLogger('VPS8');
interface Vps8Config {
  apiKey: string;
  client: string;
  domain?: string;
  useProxy?: boolean;
}

interface Vps8Response<T = unknown> {
  result?: T;
  error?: {
    message?: string;
    code?: number;
  } | null;
}

export class Vps8Adapter extends BaseAdapter {
  private config: Vps8Config;
  private baseUrl = 'https://vps8.zz.cd/api/client/dnsopenapi';

  constructor(config: Record<string, string>) {
    super();
    this.config = {
      apiKey: safeString(config.apiKey) || safeString(config.apikey),
      client: safeString(config.client),
      domain: safeString(config.domain),
      useProxy: !!config.useProxy,
    };
  }

  private async request<T>(endpoint: string, params: Record<string, unknown> = {}): Promise<T> {
    const url = `${this.baseUrl}/${endpoint}`;
    const body = JSON.stringify(params);

    try {
      // HTTP Basic Auth: username="client" (fixed literal string), password=apiKey
      const credentials = Buffer.from(`client:${this.config.apiKey}`).toString('base64');

      const res = await fetchWithFallback(url, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/json',
        },
        body,
      }, this.config.useProxy, 'VPS8');

      const text = await res.text();
      let payload: unknown = undefined;

      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          throw new Error(`Invalid JSON response: ${text.slice(0, 200)}`);
        }
      }

      const data = payload as Vps8Response<T>;

      // 如果响应有 error 字段且不为 null，抛出错误
      if (data.error && data.error.code && data.error.code !== 200) {
        throw new Error(safeString(data.error.message) || 'VPS8 API request failed');
      }

      return (data.result ?? {}) as T;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(String(error));
    }
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

  async getDomainList(keyword?: string, _page = 1, _pageSize = 50): Promise<PageResult<DomainInfo>> {
    try {
      log.debug('Fetching domain list', {
        client: this.config.client,
        apiKeyLength: this.config.apiKey.length,
        baseUrl: this.baseUrl
      });

      const response = await this.request<Array<{
        domain: string;
        id?: string;
        expires_at?: string;
        created_at?: string;
      }>>('domain_list', {});

      let list = (response || []).map((item) => ({
        Domain: safeString(item.domain),
        ThirdId: safeString(item.id) || safeString(item.domain),
        RecordCount: undefined as number | undefined,
        ExpiresAt: item.expires_at ? new Date(item.expires_at).toISOString() : undefined,
      }));

      if (keyword) {
        list = list.filter((d) => d.Domain.toLowerCase().includes(keyword.toLowerCase()));
      }

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
    _line?: string,
    _status?: number
  ): Promise<PageResult<DnsRecord>> {
    try {
      if (!this.config.domain) {
        return { total: 0, list: [] };
      }

      const response = await this.request<Array<Dict>>('record_list', {
        domain: this.config.domain,
      });

      let list = (response || []).map((r) => this.mapRecord(r));

      // 过滤条件
      if (subdomain) {
        list = list.filter((r) => r.Name.toLowerCase() === subdomain.toLowerCase());
      } else if (keyword) {
        const lower = keyword.toLowerCase();
        list = list.filter(
          (r) => r.Name.toLowerCase().includes(lower) || r.Value.toLowerCase().includes(lower)
        );
      }
      if (value) {
        list = list.filter((r) => r.Value === value);
      }
      if (type) {
        list = list.filter((r) => r.Type === type);
      }

      // 分页
      const start = Math.max(0, (page - 1) * pageSize);
      const end = start + pageSize;
      return { total: list.length, list: list.slice(start, end) };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return { total: 0, list: [] };
    }
  }

  async getDomainRecordInfo(recordId: string): Promise<DnsRecord | null> {
    try {
      const records = await this.getDomainRecords(1, 500);
      return records.list.find((r) => r.RecordId === recordId) || null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  async addDomainRecord(
    name: string,
    type: string,
    value: string,
    _line?: string,
    ttl = 600,
    mx?: number,
    _weight?: number,
    _remark?: string
  ): Promise<string | null> {
    try {
      if (!this.config.domain) {
        return null;
      }

      const params: Record<string, unknown> = {
        domain: this.config.domain,
        host: name === '@' ? '' : name,
        type: type.toUpperCase(),
        value,
        ttl: toNumber(ttl, 600),
      };

      if (type.toUpperCase() === 'MX' && mx !== undefined) {
        params.mx = mx;
      }

      const response = await this.request<{ id: string }>('record_create', params);
      const createdId = safeString(response.id);
      if (createdId) return createdId;
      return await resolveCreatedRecordId(this, name, type);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      log.error('addDomainRecord failed', this.error);
      return null;
    }
  }

  async updateDomainRecord(
    recordId: string,
    name: string,
    type: string,
    value: string,
    _line?: string,
    ttl = 600,
    mx?: number,
    _weight?: number,
    _remark?: string
  ): Promise<boolean> {
    try {
      if (!this.config.domain) {
        return false;
      }

      log.debug('Updating record', { recordId, domain: this.config.domain });

      const params: Record<string, unknown> = {
        domain: this.config.domain,
        id: recordId,
        value,
        ttl: toNumber(ttl, 600),
      };

      if (type.toUpperCase() === 'MX' && mx !== undefined) {
        params.mx = mx;
      }

      await this.request('record_update', params);
      log.debug('Record updated successfully', { recordId });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      log.error('updateDomainRecord failed', {
        recordId,
        error: this.error
      });
      return false;
    }
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    try {
      if (!this.config.domain) {
        return false;
      }

      log.debug('Deleting record', { recordId, domain: this.config.domain });

      await this.request('record_delete', {
        domain: this.config.domain,
        id: recordId,
      });

      log.debug('Record deleted successfully', { recordId });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      log.error('deleteDomainRecord failed', {
        recordId,
        error: this.error
      });
      return false;
    }
  }

  async setDomainRecordStatus(_recordId: string, _status: number): Promise<boolean> {
    this.error = 'VPS8 does not support record status toggle';
    return false;
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    return [{ id: '0', name: '默认' }];
  }

  async getMinTTL(): Promise<number> {
    return 600;
  }

  async addDomain(_domain: string): Promise<boolean> {
    this.error = 'VPS8 does not support domain registration via API';
    return false;
  }

  private mapRecord(r: Dict): DnsRecord {
    const domain = this.config.domain || '';
    const host = safeString(r.host) || '@';
    const type = safeString(r.type);
    let value = safeString(r.value);
    let mx = 0;

    // 处理 MX 记录
    if (type === 'MX' && r.mx !== undefined) {
      mx = toNumber(r.mx, 0);
    }

    // VPS8 API 返回的 id 是数字类型，需要转换为字符串
    const recordId = r.id ? String(r.id) : (r.provider_record_id ? String(r.provider_record_id) : '');

    return {
      RecordId: recordId || `${type}|${host}|${value}`,
      Domain: domain,
      Name: host,
      Type: type,
      Value: value,
      Line: 'default',
      TTL: toNumber(r.ttl, 600),
      MX: mx,
      Status: 1,
      Weight: undefined,
      Remark: undefined,
      UpdateTime: undefined,
    };
  }
}
