import {createProviderAdapterLogger, DnsAdapter, DnsRecord, DomainInfo, PageResult, BaseAdapter, Dict, resolveDomainIdHelper, safeString, toNumber, fetchWithFallback, resolveCreatedRecordId } from '../internal';

const log = createProviderAdapterLogger('Powerdns');
interface PowerdnsConfig {
  serverUrl: string;
  apiKey: string;
  serverId: string;
  domain?: string;
  domainId?: string;
  useProxy?: boolean;
}

interface Rrset {
  id?: number;
  name: string;
  type: string;
  ttl: number;
  records: Array<{ content: string; disabled: boolean; id?: number }>;
  comments?: Array<{ account: string; content: string }>;
  host?: string;
}

export class PowerdnsAdapter extends BaseAdapter {
  private config: PowerdnsConfig;
  private rrsetsCache: Rrset[] | null = null;

  constructor(config: Record<string, string>) {
    super();

    const rawServerUrl = safeString(config.serverUrl);
    const ip = safeString(config.ip);
    const port = safeString(config.port) || '8081';
    const legacyServerUrl = ip ? `http://${ip}:${port}` : '';
    const serverUrl = rawServerUrl || legacyServerUrl;

    this.config = {
      // Prefer UI keys (`serverUrl` / `apiKey`), keep legacy keys for backward compatibility.
      serverUrl,
      apiKey: safeString(config.apiKey) || safeString(config.apikey),
      serverId: safeString(config.serverId) || 'localhost',
      domain: safeString(config.domain),
      domainId: safeString(config.zoneId),
      useProxy: !!config.useProxy,
    };
  }

  private getBaseUrl(): string {
    const base = safeString(this.config.serverUrl).replace(/\/+$/, '');
    if (!base) {
      // Keep a usable error for callers; request() will fail if called.
      this.error = 'PowerDNS: serverUrl is required';
      return '/api/v1';
    }
    return base.endsWith('/api/v1') ? base : `${base}/api/v1`;
  }

  private getHeaders(): Record<string, string> {
    return {
      'X-API-Key': this.config.apiKey,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(method: string, path: string, params?: Dict): Promise<T> {
    let url = `${this.getBaseUrl()}${path}`;
    let body: string | undefined;

    if (method === 'GET' && params) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        query.set(key, String(value));
      }
      url += '?' + query.toString();
    } else if ((method === 'POST' || method === 'PUT' || method === 'PATCH') && params) {
      body = JSON.stringify(params);
    }

    const res = await fetchWithFallback(url, { method, headers: this.getHeaders(), body }, this.config.useProxy, 'PowerDNS');
    const data = (await res.json()) as Dict;

    if (!res.ok) {
      const errorMsg = safeString(data.error) || (data.errors ? (data.errors as string[]).join(',') : `PowerDNS request failed: ${res.status}`);
      throw new Error(errorMsg);
    }

    return (res.status === 204 ? true : data) as T;
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

  async getDomainList(keyword?: string, _page = 1, _pageSize = 20): Promise<PageResult<DomainInfo>> {
    try {
      const data = await this.request<Array<{ id: string; name: string }>>('GET', `/servers/${this.config.serverId}/zones`);
      let list = (data || []).map((row) => ({
        Domain: row.name.replace(/\.$/, ''),
        ThirdId: row.id,
        RecordCount: 0,
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

  /**
   * 根据域名查找 Domain ID (Zone ID)
   * 当 config.domainId 未设置时，尝试通过域名搜索获取
   */
  private async resolveDomainId(): Promise<string | null> {
    return resolveDomainIdHelper(this.config, this.getDomainList.bind(this), 'Powerdns');
  }

  async getDomainRecords(
    _page = 1,
    _pageSize = 20,
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
        this.error = this.error || '读取记录失败：未解析到域名或上游返回空结果';
        return { total: 0, list: [] };
      }

      const data = await this.request<{ rrsets: Rrset[] }>('GET', `/servers/${this.config.serverId}/zones/${domainId}`);
      this.rrsetsCache = data.rrsets || [];

      let rrsetId = 0;
      let list: DnsRecord[] = [];

      for (const rrset of this.rrsetsCache) {
        rrsetId++;
        const name = rrset.name === this.config.domainId ? '@' : rrset.name.replace(`.${this.config.domainId}`, '');
        rrset.host = name;
        rrset.id = rrsetId;

        let recordId = 0;
        for (const record of rrset.records) {
          recordId++;
          record.id = recordId;

          let recordValue = record.content;
          let mx: number | undefined;
          if (rrset.type === 'MX') {
            const parts = record.content.split(' ');
            mx = toNumber(parts[0], 0);
            recordValue = parts.slice(1).join(' ');
          }

          const remark = rrset.comments && rrset.comments.length > 0 ? rrset.comments[0].content : undefined;

          list.push({
            RecordId: `${rrsetId}_${recordId}`,
            Domain: this.config.domain || '',
            Name: name,
            Type: rrset.type,
            Value: recordValue,
            Line: 'default',
            TTL: rrset.ttl,
            MX: mx || 0,
            Status: record.disabled ? 0 : 1,
            Weight: undefined,
            Remark: remark,
            UpdateTime: undefined,
          });
        }
      }

      if (subdomain) {
        list = list.filter((r) => r.Name.toLowerCase() === subdomain.toLowerCase());
      } else {
        if (keyword) {
          const lowerKeyword = keyword.toLowerCase();
          list = list.filter((r) => r.Name.toLowerCase().includes(lowerKeyword) || r.Value.toLowerCase().includes(lowerKeyword));
        }
        if (value) {
          list = list.filter((r) => r.Value === value);
        }
        if (type) {
          list = list.filter((r) => r.Type === type);
        }
        if (status !== undefined) {
          list = list.filter((r) => r.Status === status);
        }
      }

      return { total: list.length, list };
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
    remark?: string
  ): Promise<string | null> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        return null;
      }

      let recordValue = value;
      if (type === 'TXT' && !recordValue.startsWith('"')) {
        recordValue = `"${recordValue}"`;
      }
      if ((type === 'CNAME' || type === 'MX') && !recordValue.endsWith('.')) {
        recordValue += '.';
      }
      if (type === 'MX') {
        recordValue = `${mx} ${recordValue}`;
      }

      const records = [{ content: recordValue, disabled: false }];
      await this.rrsetReplace(name, type, ttl, records, remark, domainId);
      // rrset replace 不返回记录 ID：回查一次，拿不到就按失败处理（不能编造 'success'）
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
    _line?: string,
    ttl = 600,
    mx = 1,
    _weight?: number,
    remark?: string
  ): Promise<boolean> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId || !this.rrsetsCache) {
        return false;
      }

      const [rrsetIdStr, recordIdStr] = recordId.split('_');
      const rrsetId = toNumber(rrsetIdStr, 0);
      const recId = toNumber(recordIdStr, 0);

      let recordValue = value;
      if (type === 'TXT' && !recordValue.startsWith('"')) {
        recordValue = `"${recordValue}"`;
      }
      if ((type === 'CNAME' || type === 'MX') && !recordValue.endsWith('.')) {
        recordValue += '.';
      }
      if (type === 'MX') {
        recordValue = `${mx} ${recordValue}`;
      }

      for (const rrset of this.rrsetsCache) {
        if (rrset.id === rrsetId) {
          let found = false;
          for (const record of rrset.records) {
            if (record.id === recId) {
              found = true;
              record.content = recordValue;
              break;
            }
          }
          if (!found) {
            this.error = '记录不存在';
            return false;
          }
          await this.rrsetReplace(rrset.host || '', rrset.type, ttl, rrset.records, remark, domainId);
          return true;
        }
      }

      this.error = '记录不存在';
      return false;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId || !this.rrsetsCache) {
        return false;
      }

      const [rrsetIdStr, recordIdStr] = recordId.split('_');
      const rrsetId = toNumber(rrsetIdStr, 0);
      const recId = toNumber(recordIdStr, 0);

      for (const rrset of this.rrsetsCache) {
        if (rrset.id === rrsetId) {
          let found = false;
          rrset.records = rrset.records.filter((record) => {
            if (record.id === recId) {
              found = true;
              return false;
            }
            return true;
          });

          if (!found) {
            this.error = '记录不存在';
            return false;
          }

          if (rrset.records.length > 0) {
            await this.rrsetReplace(rrset.host || '', rrset.type, rrset.ttl, rrset.records, undefined, domainId);
          } else {
            await this.rrsetDelete(rrset.host || '', rrset.type, domainId);
          }
          return true;
        }
      }

      this.error = '记录不存在';
      return false;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async setDomainRecordStatus(recordId: string, status: number): Promise<boolean> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId || !this.rrsetsCache) {
        return false;
      }

      const [rrsetIdStr, recordIdStr] = recordId.split('_');
      const rrsetId = toNumber(rrsetIdStr, 0);
      const recId = toNumber(recordIdStr, 0);

      for (const rrset of this.rrsetsCache) {
        if (rrset.id === rrsetId) {
          let found = false;
          for (const record of rrset.records) {
            if (record.id === recId) {
              found = true;
              record.disabled = status === 0;
              break;
            }
          }
          if (!found) {
            this.error = '记录不存在';
            return false;
          }
          await this.rrsetReplace(rrset.host || '', rrset.type, rrset.ttl, rrset.records, undefined, domainId);
          return true;
        }
      }

      this.error = '记录不存在';
      return false;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    return [{ id: '0', name: '默认' }];
  }

  async getMinTTL(): Promise<number> {
    return 60;
  }

  async addDomain(domain: string): Promise<boolean> {
    try {
      let domainName = domain;
      if (!domainName.endsWith('.')) {
        domainName += '.';
      }
      await this.request('POST', `/servers/${this.config.serverId}/zones`, {
        name: domainName,
        kind: 'Native',
        soa_edit_api: 'INCREASE',
      });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  private async rrsetReplace(host: string, type: string, ttl: number, records: Array<{ content: string; disabled: boolean }>, remark?: string, domainId?: string): Promise<void> {
    const zoneId = domainId || this.config.domainId;
    if (!zoneId) {
      throw new Error('Domain ID not set');
    }
    const name = host === '@' ? zoneId : `${host}.${zoneId}`;
    const rrset: Dict = {
      name,
      type,
      ttl: toNumber(ttl, 600),
      changetype: 'REPLACE',
      records,
      comments: [],
    };
    if (remark) {
      rrset.comments = [{ account: '', content: remark }];
    }
    await this.request('PATCH', `/servers/${this.config.serverId}/zones/${zoneId}`, { rrsets: [rrset] });
  }

  private async rrsetDelete(host: string, type: string, domainId?: string): Promise<void> {
    const zoneId = domainId || this.config.domainId;
    if (!zoneId) {
      throw new Error('Domain ID not set');
    }
    const name = host === '@' ? zoneId : `${host}.${zoneId}`;
    await this.request('PATCH', `/servers/${this.config.serverId}/zones/${zoneId}`, {
      rrsets: [{ name, type, changetype: 'DELETE' }],
    });
  }
}
