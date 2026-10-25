import { createProviderAdapterLogger, DnsAdapter, DnsRecord, DomainInfo, PageResult, BaseAdapter, Dict, safeString, toNumber, fetchWithFallback } from '../internal';

const log = createProviderAdapterLogger('Spaceship');
interface SpaceshipConfig {
  apiKey: string;
  apiSecret: string;
  domain?: string;
  useProxy?: boolean;
}

export class SpaceshipAdapter extends BaseAdapter {
  private config: SpaceshipConfig;
  private baseUrl = 'https://spaceship.dev/api/v1';

  constructor(config: Record<string, string>) {
    super();
    this.config = {
      // UI uses `apiKey`/`apiSecret`; keep legacy `apikey`/`apisecret` for backward compatibility.
      apiKey: safeString(config.apiKey) || safeString(config.apikey),
      apiSecret: safeString(config.apiSecret) || safeString(config.apisecret),
      domain: safeString(config.domain),
      useProxy: !!config.useProxy,
    };
  }

  private getHeaders(): Record<string, string> {
    return {
      'X-API-Key': this.config.apiKey,
      'X-API-Secret': this.config.apiSecret,
    };
  }

  private async request<T>(method: string, path: string, params?: Dict): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    let body: string | undefined;
    const headers = this.getHeaders();

    if (method === 'GET') {
      if (params) {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
          query.set(key, String(value));
        }
        url += '?' + query.toString();
      }
    } else {
      body = JSON.stringify(params);
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetchWithFallback(url, { method, headers, body }, this.config.useProxy, 'Spaceship');
    const data = (await res.json()) as Dict;

    if (res.status !== 200 && res.status !== 204) {
      throw new Error(safeString(data.detail) || `Spaceship request failed: ${res.status}`);
    }

    return (res.status === 204 ? undefined : data) as T;
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

  async getDomainList(keyword?: string, page = 1, pageSize = 100): Promise<PageResult<DomainInfo>> {
    try {
      const data = await this.request<{ items: Array<{ name: string }>; total: number }>('GET', '/domains', { take: pageSize, skip: (page - 1) * pageSize });
      let list = (data.items || []).map((row) => ({
        Domain: row.name,
        ThirdId: row.name,
        RecordCount: 0,
      }));
      if (keyword) {
        list = list.filter((d) => d.Domain.toLowerCase().includes(keyword.toLowerCase()));
      }
      return { total: data.total || list.length, list };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      log.error('getDomainList failed', this.error);
      return { total: 0, list: [] };
    }
  }

  async getDomainRecords(
    page = 1,
    pageSize = 20,
    _keyword?: string,
    subdomain?: string,
    _value?: string,
    _type?: string,
    _line?: string,
    _status?: number
  ): Promise<PageResult<DnsRecord>> {
    try {
      if (!this.config.domain) {
        this.error = this.error || '读取记录失败：未解析到域名或上游返回空结果';
        return { total: 0, list: [] };
      }

      const params: Dict = { take: pageSize, skip: (page - 1) * pageSize };
      if (subdomain) {
        params.take = 100;
        params.skip = 0;
      }

      const data = await this.request<{ items: Array<Dict>; total: number }>('GET', `/dns/records/${this.config.domain}`, params);
      let list = (data.items || []).map((row) => this.mapRecord(row));

      if (subdomain) {
        list = list.filter((r) => r.Name.toLowerCase() === subdomain.toLowerCase());
      }

      return { total: data.total || list.length, list };
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
    _line?: string,
    ttl = 600,
    mx = 1,
    _weight?: number,
    _remark?: string
  ): Promise<string | null> {
    try {
      if (!this.config.domain) {
        return null;
      }

      const item = this.convertRecordItem(name, type, value, mx);
      item.ttl = toNumber(ttl, 600);

      await this.request('PUT', `/dns/records/${this.config.domain}`, { force: false, items: [item] });
      return `${type}|${name}|${value}|${mx}`;
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
    _line?: string,
    ttl = 600,
    mx = 1,
    _weight?: number,
    _remark?: string
  ): Promise<boolean> {
    try {
      if (!this.config.domain) {
        return false;
      }

      const item = this.convertRecordItem(name, type, value, mx);
      item.ttl = toNumber(ttl, 600);

      await this.request('PUT', `/dns/records/${this.config.domain}`, { force: true, items: [item] });
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

      const parts = recordId.split('|');
      const type = parts[0];
      const name = parts[1];
      const address = parts[2];
      const mx = parts[3] || '0';

      const item = this.convertRecordItem(name, type, address, toNumber(mx, 0));
      await this.request('DELETE', `/dns/records/${this.config.domain}`, item as unknown as Dict);
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async setDomainRecordStatus(_recordId: string, _status: number): Promise<boolean> {
    this.error = 'Spaceship does not support record status toggle';
    return false;
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    return [{ id: '0', name: '默认' }];
  }

  async getMinTTL(): Promise<number> {
    return 60;
  }

  async addDomain(_domain: string): Promise<boolean> {
    this.error = 'Spaceship does not support domain registration via API';
    return false;
  }

  private convertRecordItem(name: string, type: string, value: string, mx: number): Dict {
    const item: Dict = { type, name };

    if (type === 'MX') {
      item.exchange = value;
      item.preference = mx;
    } else if (type === 'TXT') {
      item.value = value;
    } else if (type === 'CNAME') {
      item.cname = value;
    } else if (type === 'ALIAS') {
      item.aliasName = value;
    } else if (type === 'NS') {
      item.nameserver = value;
    } else if (type === 'PTR') {
      item.pointer = value;
    } else if (type === 'CAA') {
      const parts = value.split(' ', 3);
      if (parts.length >= 3) {
        item.flag = toNumber(parts[0], 0);
        item.tag = parts[1];
        item.value = parts[2].replace(/^"|"$/g, '');
      }
    } else if (type === 'SRV') {
      const parts = value.split(' ', 4);
      if (parts.length >= 4) {
        item.priority = toNumber(parts[0], 0);
        item.weight = toNumber(parts[1], 0);
        item.port = toNumber(parts[2], 0);
        item.target = parts[3];
      }
    } else {
      item.address = value;
    }
    return item;
  }

  private mapRecord(row: Dict): DnsRecord {
    const type = safeString(row.type);
    let value = '';
    let mx = 0;

    if (type === 'MX') {
      value = safeString(row.exchange);
      mx = toNumber(row.preference, 0);
    } else if (type === 'CNAME') {
      value = safeString(row.cname);
    } else if (type === 'TXT') {
      value = safeString(row.value);
    } else if (type === 'PTR') {
      value = safeString(row.pointer);
    } else if (type === 'NS') {
      value = safeString(row.nameserver);
    } else if (type === 'CAA') {
      value = `${row.flag} ${row.tag} "${row.value}"`;
    } else if (type === 'SRV') {
      value = `${row.priority} ${row.weight} ${row.port} ${row.target}`;
    } else if (type === 'ALIAS') {
      value = safeString(row.aliasName);
    } else {
      value = safeString(row.address);
    }

    return {
      RecordId: `${type}|${row.name}|${value}|${mx}`,
      Domain: this.config.domain || '',
      Name: safeString(row.name),
      Type: type,
      Value: value,
      Line: 'default',
      TTL: toNumber(row.ttl, 600),
      MX: mx,
      Status: 1,
      Weight: undefined,
      Remark: undefined,
      UpdateTime: undefined,
    };
  }
}
