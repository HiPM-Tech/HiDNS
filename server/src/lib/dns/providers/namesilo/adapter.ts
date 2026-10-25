import {createProviderAdapterLogger, DnsRecord, DomainInfo, PageResult, asArray, BaseAdapter, normalizeRrName, safeString, toNumber, requestXml, resolveCreatedRecordId, normalizeLine } from '../internal';
export const DEFAULT_LINE = '0';

const log = createProviderAdapterLogger('Namesilo');
interface NamesiloConfig {
  apikey: string;
  domain?: string;
}

type XmlDict = Record<string, unknown>;

export class NamesiloAdapter extends BaseAdapter {
  private config: NamesiloConfig;
  private baseUrl = 'https://www.namesilo.com/api';

  constructor(config: Record<string, string>) {
    super();
    this.config = {
      apikey: safeString(config.apikey),
      domain: safeString(config.domain),
    };
  }

  private normalizeLine(line?: string): string {
    return safeString(line) || 'default';
  }

  private toList<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : value ? [value as T] : [];
  }

  private resolveReply(payload: XmlDict): XmlDict {
    const root = (payload.namesilo as XmlDict | undefined) ?? payload;
    return (root.reply as XmlDict | undefined) ?? {};
  }

  private mapError(reply: XmlDict, operation: string): string | undefined {
    const code = safeString(reply.code);
    if (code === '300') return undefined;
    return safeString(reply.detail) || `Namesilo ${operation} failed`;
  }

  private async request(operation: string, params: Record<string, string> = {}): Promise<XmlDict> {
    const query = { version: '1', type: 'xml', key: this.config.apikey, ...params };
    const url = `${this.baseUrl}/${operation}`;
    const data = await requestXml<XmlDict>(url, {
      query,
      parseError: (payload) => {
        const reply = this.resolveReply((payload ?? {}) as XmlDict);
        return this.mapError(reply, operation);
      },
    });
    return this.resolveReply(data);
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
      const reply = await this.request('listDomains');
      const domainsNode = (reply.domains as XmlDict | undefined)?.domain;
      let list = this.toList<string>(domainsNode).map((domain) => ({
        Domain: safeString(domain),
        ThirdId: safeString(domain),
        RecordCount: undefined as number | undefined,
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
    line?: string,
    _status?: number
  ): Promise<PageResult<DnsRecord>> {
    try {
      if (!this.config.domain) { this.error = this.error || '读取记录失败：未解析到域名或上游返回空结果'; return { total: 0, list: [] }; }
      const reply = await this.request('dnsListRecords', { domain: this.config.domain });
      const listNode = reply.resource_record;
      let list = this.toList<XmlDict>(listNode).map((r) => this.mapRecord(r, this.normalizeLine(line)));
      if (subdomain) list = list.filter((r) => r.Name.toLowerCase() === subdomain.toLowerCase());
      else if (keyword) {
        const lower = keyword.toLowerCase();
        list = list.filter((r) => r.Name.toLowerCase().includes(lower) || r.Value.toLowerCase().includes(lower));
      }
      if (value) list = list.filter((r) => r.Value === value);
      if (type) list = list.filter((r) => r.Type === type);

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

  async addDomainRecord(name: string, type: string, value: string, _line?: string, ttl = 7207, _mx?: number, _weight?: number, _remark?: string): Promise<string | null> {
    try {
      if (!this.config.domain) return null;
      const reply = await this.request('dnsAddRecord', {
        domain: this.config.domain,
        rrtype: type,
        rrhost: normalizeRrName(name),
        rrvalue: value,
        rrttl: String(ttl),
      });
      const createdId = safeString(reply.record_id);
      if (createdId) return createdId;
      return await resolveCreatedRecordId(this, name, type);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  async updateDomainRecord(recordId: string, name: string, type: string, value: string, _line?: string, ttl = 7207, _mx?: number, _weight?: number, _remark?: string): Promise<boolean> {
    try {
      if (!this.config.domain) return false;
      await this.request('dnsUpdateRecord', {
        domain: this.config.domain,
        rrid: recordId,
        rrtype: type,
        rrhost: normalizeRrName(name),
        rrvalue: value,
        rrttl: String(ttl),
      });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    try {
      if (!this.config.domain) return false;
      await this.request('dnsDeleteRecord', { domain: this.config.domain, rrid: recordId });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async setDomainRecordStatus(_recordId: string, _status: number): Promise<boolean> {
    this.error = 'NameSilo does not support record status toggle';
    return false;
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    return [{ id: '0', name: '默认' }];
  }

  async getMinTTL(): Promise<number> {
    return 3600;
  }

  async addDomain(_domain: string): Promise<boolean> {
    this.error = 'NameSilo does not support domain registration via API';
    return false;
  }

  private mapRecord(r: XmlDict, line = '0'): DnsRecord {
    const domain = this.config.domain || '';
    const host = safeString(r.host);
    return {
      RecordId: safeString(r.record_id),
      Domain: domain,
      Name: host === '' ? '@' : host,
      Type: safeString(r.type),
      Value: safeString(r.value),
      Line: line,
      TTL: toNumber(r.ttl, 7207),
      MX: 0,
      Status: 1,
    };
  }
}
