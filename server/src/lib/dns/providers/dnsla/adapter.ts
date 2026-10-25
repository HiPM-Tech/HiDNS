import { createProviderAdapterLogger, DnsAdapter, DnsRecord, DomainInfo, PageResult, BaseAdapter, Dict, resolveDomainIdHelper, safeString, toNumber, fetchWithFallback, resolveProviderLine } from '../internal';

const log = createProviderAdapterLogger('Dnsla');
interface DnslaConfig {
  apiid: string;
  apisecret: string;
  domain?: string;
  domainId?: string;
  useProxy?: boolean;
}

export class DnslaAdapter extends BaseAdapter {
  private config: DnslaConfig;
  private baseUrl = 'https://api.dns.la';
  private typeList: Record<number, string> = {
    1: 'A',
    2: 'NS',
    5: 'CNAME',
    15: 'MX',
    16: 'TXT',
    28: 'AAAA',
    33: 'SRV',
    256: 'URL转发',
    257: 'CAA',
  };

  constructor(config: Record<string, string>) {
    super();
    this.config = {
      apiid: safeString(config.apiid),
      apisecret: safeString(config.apisecret),
      domain: safeString(config.domain),
      domainId: safeString(config.zoneId),
      useProxy: !!config.useProxy,
    };
  }

  private getAuthHeader(): Record<string, string> {
    const token = Buffer.from(`${this.config.apiid}:${this.config.apisecret}`).toString('base64');
    return {
      Authorization: `Basic ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    };
  }

  private async request<T>(method: string, path: string, params?: Dict): Promise<T> {
    const headers = this.getAuthHeader();
    let url = `${this.baseUrl}${path}`;
    let body: string | undefined;

    if (method === 'GET' && params) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          query.set(key, String(value));
        }
      }
      url += '?' + query.toString();
    } else if ((method === 'POST' || method === 'PUT') && params) {
      body = JSON.stringify(params);
    }

    const res = await fetchWithFallback(url, { method, headers, body }, this.config.useProxy, 'DNSLA');
    const data = (await res.json()) as Dict;

    if (!res.ok || data.code !== 200) {
      throw new Error(safeString(data.msg) || `DNSLA request failed: ${res.status}`);
    }

    return data.data as T;
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
      const data = await this.request<{ results: Array<{ id: string; displayDomain: string }>; total: number }>('GET', '/api/domainList', { pageIndex: page, pageSize });
      let list = (data.results || []).map((row) => ({
        Domain: row.displayDomain.replace(/\.$/, ''),
        ThirdId: row.id,
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

  /**
   * 根据域名查找 Domain ID
   * 当 config.domainId 未设置时，尝试通过域名搜索获取
   */
  private async resolveDomainId(): Promise<string | null> {
    return resolveDomainIdHelper(this.config, this.getDomainList.bind(this), 'DNSLA');
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
        return { total: 0, list: [] };
      }

      const params: Dict = { domainId: domainId, pageIndex: page, pageSize };
      if (subdomain) {
        params.host = subdomain;
      } else if (keyword) {
        params.host = keyword;
      }
      if (type) {
        params.type = this.convertType(type);
      }
      if (line) {
        params.lineId = line;
      }
      if (value) {
        params.data = value;
      }

      const data = await this.request<{ results: Array<Dict>; total: number }>('GET', '/api/recordList', params);
      const list = (data.results || []).map((row) => this.mapRecord(row));
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

      const params: Dict = {
        domainId: domainId,
        type: this.convertType(type),
        host: name,
        data: value,
        ttl: toNumber(ttl, 600),
        lineId: resolveProviderLine(line, '0'),
      };

      if (type === 'MX') {
        params.preference = toNumber(mx, 1);
      }
      if (type === 'REDIRECT_URL') {
        params.type = 256;
        params.dominant = true;
      } else if (type === 'FORWARD_URL') {
        params.type = 256;
        params.dominant = false;
      }
      if (weight && weight > 0) {
        params.weight = weight;
      }

      const data = await this.request<{ id: string }>('POST', '/api/record', params);
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
    weight?: number,
    _remark?: string
  ): Promise<boolean> {
    try {
      const params: Dict = {
        id: recordId,
        type: this.convertType(type),
        host: name,
        data: value,
        ttl: toNumber(ttl, 600),
        lineId: resolveProviderLine(line, '0'),
      };

      if (type === 'MX') {
        params.preference = toNumber(mx, 1);
      }
      if (type === 'REDIRECT_URL') {
        params.type = 256;
        params.dominant = true;
      } else if (type === 'FORWARD_URL') {
        params.type = 256;
        params.dominant = false;
      }
      if (weight && weight > 0) {
        params.weight = weight;
      }

      await this.request('PUT', '/api/record', params);
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    try {
      await this.request('DELETE', '/api/record', { id: recordId });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async setDomainRecordStatus(recordId: string, status: number): Promise<boolean> {
    try {
      await this.request('PUT', '/api/recordDisable', { id: recordId, disable: status === 0 });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    try {
      if (!this.config.domain) {
        this.error = '线路查询失败（dnsla）';
        throw new Error(this.error);
      }
      const data = await this.request<Array<{ id: string; value: string; pid?: string; order: number }>>('GET', '/api/availableLine', { domain: this.config.domain });
      const sorted = (data || []).sort((a, b) => a.order - b.order);
      // 默认线路在 API 里可能是 '0'，保持与 defaultLine 一致（此前映射成 '' 会让「选默认」与「不传」落到不同值）
      return sorted.map((row) => ({ id: row.id, name: row.value }));
    } catch (e) {
      this.error = '线路查询失败（dnsla）';
        throw new Error(this.error);
    }
  }

  async getMinTTL(): Promise<number> {
    try {
      if (!this.config.domainId) {
        return 600;
      }
      const data = await this.request<{ minTTL: number }>('GET', '/api/dnsMeasures', { id: this.config.domainId });
      return data.minTTL || 600;
    } catch (e) {
      return 600;
    }
  }

  async addDomain(domain: string): Promise<boolean> {
    try {
      await this.request('POST', '/api/domain', { domain });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  private convertType(type: string): number {
    const typeMap: Record<string, number> = {
      A: 1,
      NS: 2,
      CNAME: 5,
      MX: 15,
      TXT: 16,
      AAAA: 28,
      SRV: 33,
      'URL转发': 256,
      REDIRECT_URL: 256,
      FORWARD_URL: 256,
      CAA: 257,
    };
    return typeMap[type] || 1;
  }

  private convertTypeId(typeId: number, dominant?: boolean): string {
    if (typeId === 256) {
      return dominant ? 'REDIRECT_URL' : 'FORWARD_URL';
    }
    return this.typeList[typeId] || 'A';
  }


  private mapRecord(row: Dict): DnsRecord {
    return {
      RecordId: safeString(row.id),
      Domain: this.config.domain || '',
      Name: safeString(row.host),
      Type: this.convertTypeId(toNumber(row.type, 1), row.dominant as boolean),
      Value: safeString(row.data),
      Line: safeString(row.lineId) || '',
      TTL: toNumber(row.ttl, 600),
      MX: row.preference ? toNumber(row.preference, 0) : 0,
      Status: row.disable ? 0 : 1,
      Weight: row.weight ? toNumber(row.weight, 0) : undefined,
      Remark: undefined,
      UpdateTime: row.updatedAt ? new Date(row.updatedAt as number * 1000).toISOString() : undefined,
    };
  }
}
