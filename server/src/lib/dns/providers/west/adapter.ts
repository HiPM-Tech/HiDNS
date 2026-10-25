import { createProviderAdapterLogger, DnsAdapter, DnsRecord, DomainInfo, PageResult, asArray, BaseAdapter, Dict, normalizeRrName, safeString, toNumber, fetchWithFallback, resolveProviderLine } from '../internal';
import crypto from 'node:crypto';

const log = createProviderAdapterLogger('West');
interface WestConfig {
  username: string;
  apiPassword: string;
  domain?: string;
  useProxy?: boolean;
}

interface WestDomainItem {
  id: string;
  domain: string;
}

interface WestRecordItem {
  id: number | string;
  item: string;
  value: string;
  type: string;
  level: number | string;
  ttl: number | string;
  line: string;
  pause: number | string;
}

interface WestDomainListData {
  items?: WestDomainItem[];
  total?: number | string;
  limit?: number | string;
  pageno?: number | string;
}

interface WestRecordListData {
  items?: WestRecordItem[];
  total?: number | string;
  limit?: number | string;
  pageno?: number | string;
}

interface WestApiResponse<T> {
  result?: number;
  clientid?: string;
  errcode?: number;
  msg?: unknown;
  data?: T;
}

export class WestAdapter extends BaseAdapter implements DnsAdapter {
  private readonly config: WestConfig;
  private readonly baseUrl = 'https://api.west.cn/api/v2/domain/';

  constructor(config: Record<string, string>) {
    super();
    this.config = {
      username: safeString(config.username),
      apiPassword: safeString(config.api_password),
      domain: safeString(config.domain),
      useProxy: !!config.useProxy,
    };
  }

  private md5Hex(payload: string): string {
    return crypto.createHash('md5').update(payload).digest('hex');
  }

  private buildAuthParams(): Dict {
    const time = Date.now().toString();
    const token = this.md5Hex(`${this.config.username}${this.config.apiPassword}${time}`);
    return {
      username: this.config.username,
      time,
      token,
    };
  }

  private toFormBody(params: Dict): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      search.set(key, String(value));
    }
    return search.toString();
  }

  private async request<T>(method: 'GET' | 'POST', params: Dict): Promise<WestApiResponse<T>> {
    const payload = { ...params, ...this.buildAuthParams() };
    const headers: Record<string, string> = {};
    let url = this.baseUrl;
    let body: string | undefined;

    if (method === 'GET') {
      const u = new URL(this.baseUrl);
      for (const [key, value] of Object.entries(payload)) {
        if (value === undefined || value === null) continue;
        u.searchParams.set(key, String(value));
      }
      url = u.toString();
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = this.toFormBody(payload);
    }

    const res = await fetchWithFallback(url, { method, headers, body }, this.config.useProxy, 'West');
    const text = await res.text();
    let data: WestApiResponse<T>;
    try {
      data = JSON.parse(text) as WestApiResponse<T>;
    } catch {
      this.error = `Invalid response: ${text.slice(0, 200)}`;
      return {};
    }

    if (!res.ok) {
      this.error = `HTTP ${res.status}`;
      return data;
    }

    if (data.result !== 200) {
      const msg = typeof data.msg === 'string' ? data.msg : JSON.stringify(data.msg ?? {});
      this.error = msg || `West API error: ${data.errcode ?? data.result ?? 'unknown'}`;
    }

    return data;
  }

  async check(): Promise<boolean> {
    try {
      const res = await this.request<WestDomainListData>('GET', {
        act: 'getdomains',
        domain: this.config.domain || '',
        limit: 1,
        page: 1,
      });
      if (res.result === 200) return true;
      const authErrors = new Set([10000, 10001, 10002, 30204]);
      if (res.errcode && authErrors.has(res.errcode)) {
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
      const res = await this.request<WestDomainListData>('GET', {
        act: 'getdomains',
        domain: keyword ?? '',
        limit: pageSize,
        page,
      });
      if (res.result !== 200 || !res.data) {
        this.error = `读取域名列表失败：result=${res.result}`;
        return { total: 0, list: [] };
      }

      const items = asArray<WestDomainItem>(res.data.items);
      let list = items.map((item) => ({
        Domain: safeString(item.domain),
        ThirdId: safeString(item.id),
        RecordCount: undefined as number | undefined,
      }));

      if (keyword) {
        const lower = keyword.toLowerCase();
        list = list.filter((d) => d.Domain.toLowerCase().includes(lower));
      }

      return {
        total: toNumber(res.data.total, list.length),
        list,
      };
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
      if (!this.config.domain) {
        this.error = 'Domain is required';
        return { total: 0, list: [] };
      }

      const res = await this.request<WestRecordListData>('POST', {
        act: 'getdnsrecord',
        domain: this.config.domain,
        host: subdomain,
        type,
        value,
        limit: pageSize,
        pageno: page,
      });

      if (res.result !== 200 || !res.data) {
        this.error = this.error || '读取记录失败：未解析到域名或上游返回空结果';
      return { total: 0, list: [] };
      }

      let list = asArray<WestRecordItem>(res.data.items).map((item) => this.mapRecord(item));

      if (keyword) {
        const lower = keyword.toLowerCase();
        list = list.filter((r) =>
          r.Name.toLowerCase().includes(lower) || r.Value.toLowerCase().includes(lower)
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
        total: toNumber(res.data.total, list.length),
        list,
      };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return { total: 0, list: [] };
    }
  }

  async getDomainRecordInfo(recordId: string): Promise<DnsRecord | null> {
    try {
      if (!this.config.domain) {
        this.error = 'Domain is required';
        return null;
      }

      const res = await this.request<WestRecordListData>('POST', {
        act: 'getdnsrecord',
        domain: this.config.domain,
        limit: 200,
        pageno: 1,
      });

      if (res.result !== 200 || !res.data) {
        return null;
      }

      const items = asArray<WestRecordItem>(res.data.items);
      const record = items.find((item) => String(item.id) === recordId);
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
    ttl = 900,
    mx = 0,
    _weight?: number,
    _remark?: string
  ): Promise<string | null> {
    try {
      if (!this.config.domain) {
        this.error = 'Domain is required';
        return null;
      }

      const host = normalizeRrName(name);
      const payload: Dict = {
        act: 'adddnsrecord',
        domain: this.config.domain,
        host,
        type: type.toUpperCase(),
        value,
        ttl: this.normalizeTtl(ttl),
        level: this.normalizeMxForAdd(type, mx),
        line: this.toWestLine(line),
      };

      const res = await this.request<{ id?: number | string }>('POST', payload);
      if (res.result !== 200) {
        return null;
      }
      return res.data?.id ? String(res.data.id) : null;
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
    ttl = 900,
    mx = 0,
    _weight?: number,
    _remark?: string
  ): Promise<boolean> {
    try {
      if (!this.config.domain) {
        this.error = 'Domain is required';
        return false;
      }

      const payload: Dict = {
        act: 'moddnsrecord',
        domain: this.config.domain,
        id: recordId,
        value,
        ttl: this.normalizeTtl(ttl),
      };
      if (safeString(type).toUpperCase() === 'MX') {
        payload.level = this.normalizeMxForAdd(type, mx);
      }

      const res = await this.request<Dict>('POST', payload);
      return res.result === 200;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    try {
      if (!this.config.domain) {
        this.error = 'Domain is required';
        return false;
      }

      const res = await this.request<Dict>('POST', {
        act: 'deldnsrecord',
        domain: this.config.domain,
        id: recordId,
      });
      return res.result === 200;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async setDomainRecordStatus(recordId: string, status: number): Promise<boolean> {
    try {
      if (!this.config.domain) {
        this.error = 'Domain is required';
        return false;
      }

      const val = status === 1 ? 0 : 1;
      const res = await this.request<Dict>('POST', {
        act: 'pause',
        domain: this.config.domain,
        id: recordId,
        val,
      });
      return res.result === 200;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    return [
      { id: '0', name: '默认' },
      { id: 'LTEL', name: '电信' },
      { id: 'LCNC', name: '联通' },
      { id: 'LMOB', name: '移动' },
      { id: 'LEDU', name: '教育网' },
      { id: 'LSEO', name: '搜索引擎' },
    ];
  }

  async getMinTTL(): Promise<number> {
    return 60;
  }

  async addDomain(_domain: string): Promise<boolean> {
    this.error = 'West does not support domain registration via DNS API';
    return false;
  }

  private normalizeTtl(ttl: number): number {
    const n = toNumber(ttl, 900);
    return Math.min(86400, Math.max(60, n));
  }

  private normalizeMxForAdd(type: string, mx: number): number {
    if (safeString(type).toUpperCase() !== 'MX') return 10;
    const n = toNumber(mx, 10);
    return Math.min(100, Math.max(1, n));
  }

  private toWestLine(line?: string): string {
    const normalized = safeString(line);
    if (!normalized || normalized === 'default') return '';
    return normalized;
  }

  private mapRecord(record: WestRecordItem): DnsRecord {
    const name = normalizeRrName(record.item);
    const line = safeString(record.line);
    const pause = toNumber(record.pause, 0);

    return {
      RecordId: String(record.id),
      Domain: this.config.domain || '',
      Name: name,
      Type: safeString(record.type).toUpperCase(),
      Value: safeString(record.value),
      Line: resolveProviderLine(line, '0'),
      TTL: toNumber(record.ttl, 900),
      MX: toNumber(record.level, 0),
      Status: pause === 1 ? 0 : 1,
    };
  }
}
