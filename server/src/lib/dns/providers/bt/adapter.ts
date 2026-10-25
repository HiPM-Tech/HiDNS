import {createProviderAdapterLogger, DnsAdapter, DnsRecord, DomainInfo, PageResult, BaseAdapter, Dict, resolveDomainIdHelper, safeString, toNumber, fetchWithFallback, resolveCreatedRecordId } from '../internal';
import crypto from 'node:crypto';

const log = createProviderAdapterLogger('Bt');
interface BtConfig {
  AccountID: string;
  AccessKey: string;
  SecretKey: string;
  domain?: string;
  domainId?: string;
  domainType?: string;
  useProxy?: boolean;
}

export class BtAdapter extends BaseAdapter {
  private config: BtConfig;
  private baseUrl = 'https://dmp.bt.cn';

  constructor(config: Record<string, string>) {
    super();
    this.config = {
      AccountID: safeString(config.AccountID),
      AccessKey: safeString(config.AccessKey),
      SecretKey: safeString(config.SecretKey),
      domain: safeString(config.domain),
      domainId: safeString(config.zoneId),
      domainType: '1',
      useProxy: !!config.useProxy,
    };
    if (this.config.domainId) {
      const parts = this.config.domainId.split('|');
      this.config.domainId = parts[0];
      this.config.domainType = parts[1] || '1';
    }
  }

  private async request<T>(path: string, params: Dict): Promise<T> {
    const method = 'POST';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify(params);
    const signingString = [this.config.AccountID, timestamp, method, path, body].join('\n');
    const signature = crypto.createHmac('sha256', this.config.SecretKey).update(signingString).digest('hex');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Account-ID': this.config.AccountID,
      'X-Access-Key': this.config.AccessKey,
      'X-Timestamp': timestamp,
      'X-Signature': signature,
    };

    const url = `${this.baseUrl}${path}`;
    const res = await fetchWithFallback(url, { method, headers, body }, this.config.useProxy, 'BT');
    const data = (await res.json()) as Dict;

    if (!res.ok || data.code !== 0) {
      throw new Error(safeString(data.msg) || `BT request failed: ${res.status}`);
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
      const data = await this.request<{ data: Array<{ local_id: number; domain_type: number; full_domain: string; record_count: number }>; total: number }>('/api/v1/dns/manage/list_domains', { p: page, rows: pageSize, keyword });
      let list = (data.data || []).map((row) => ({
        Domain: row.full_domain,
        ThirdId: `${row.local_id}|${row.domain_type}`,
        RecordCount: row.record_count,
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
    if (this.config.domainId) {
      return this.config.domainId;
    }

    if (!this.config.domain) {
      return null;
    }

    try {
      log.debug(`Resolving domainId for domain: ${this.config.domain}`);
      const result = await this.getDomainList(this.config.domain, 1, 1);
      if (result.list.length > 0) {
        const thirdId = result.list[0].ThirdId;
        const parts = thirdId.split('|');
        const domainId = parts[0];
        const domainType = parts[1] || '1';
        log.debug(`Resolved domainId: ${domainId}, domainType: ${domainType} for domain: ${this.config.domain}`);
        // 缓存 domainId 和 domainType 避免重复查询
        this.config.domainId = domainId;
        this.config.domainType = domainType;
        return domainId;
      }
    } catch (error) {
      log.error(`Failed to resolve domainId for domain: ${this.config.domain}`, { error });
    }

    return null;
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
        return { total: 0, list: [] };
      }

      const params: Dict = { domain_id: toNumber(this.config.domainId, 0), domain_type: toNumber(this.config.domainType, 1), p: page, rows: pageSize };

      if (subdomain) {
        params.searchKey = 'record';
        params.searchValue = subdomain;
      } else if (keyword) {
        params.searchKey = 'record';
        params.searchValue = keyword;
      } else if (value) {
        params.searchKey = 'value';
        params.searchValue = value;
      } else if (type) {
        params.searchKey = 'type';
        params.searchValue = type;
      } else if (status !== undefined) {
        params.searchKey = 'state';
        params.searchValue = status === 0 ? '1' : '0';
      } else if (line) {
        params.searchKey = 'line';
        params.searchValue = line;
      }

      const data = await this.request<{ data: Array<Dict>; count: number }>('/api/v1/dns/record/list', params);
      const list = (data.data || []).map((row) => this.mapRecord(row));
      return { total: data.count || list.length, list };
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
    remark?: string
  ): Promise<string | null> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        return null;
      }

      const params: Dict = {
        domain_id: toNumber(domainId, 0),
        domain_type: toNumber(this.config.domainType, 1),
        type,
        record: name,
        value,
        ttl: toNumber(ttl, 600),
        view_id: toNumber(line, 0),
        remark,
        mx: type === 'MX' ? toNumber(mx, 1) : toNumber(weight, 1),
      };

      await this.request('/api/v1/dns/record/create', params);
      return await resolveCreatedRecordId(this, name, type);
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
        return false;
      }

      const params: Dict = {
        record_id: recordId,
        domain_id: toNumber(domainId, 0),
        domain_type: toNumber(this.config.domainType, 1),
        type,
        record: name,
        value,
        ttl: toNumber(ttl, 600),
        view_id: toNumber(line, 0),
        remark,
        mx: type === 'MX' ? toNumber(mx, 1) : toNumber(weight, 1),
      };

      await this.request('/api/v1/dns/record/update', params);
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

      await this.request('/api/v1/dns/record/delete', {
        id: recordId,
        domain_id: toNumber(domainId, 0),
        domain_type: toNumber(this.config.domainType, 1),
      });
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

      const path = status === 0 ? '/api/v1/dns/record/pause' : '/api/v1/dns/record/start';
      await this.request(path, {
        record_id: recordId,
        domain_id: toNumber(domainId, 0),
        domain_type: toNumber(this.config.domainType, 1),
      });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    try {
      const data = await this.request<Array<{ viewId: string; name: string; free: boolean }>>('/api/v1/dns/record/get_views', {});
      return (data || []).filter((line) => line.free).map((line) => ({ id: line.viewId, name: line.name }));
    } catch (e) {
      // 失败不能编造线路：返回假列表会让用户以为这些线路真实可用
      this.error = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  async getMinTTL(): Promise<number> {
    return 300;
  }

  async addDomain(domain: string): Promise<boolean> {
    try {
      await this.request('/api/v1/dns/manage/add_external_domain', { full_domain: domain });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  private mapRecord(row: Dict): DnsRecord {
    return {
      RecordId: safeString(row.record_id),
      Domain: this.config.domain || '',
      Name: safeString(row.record),
      Type: safeString(row.type),
      Value: safeString(row.value),
      Line: safeString(row.viewID) || '0',
      TTL: toNumber(row.TTL, 600),
      MX: toNumber(row.MX, 0),
      Status: row.state === 1 ? 0 : 1,
      Weight: toNumber(row.MX, 0),
      Remark: safeString(row.remark) || undefined,
      UpdateTime: row.created_at ? new Date(row.created_at as string).toISOString() : undefined,
    };
  }
}
