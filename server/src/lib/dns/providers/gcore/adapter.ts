import { createProviderAdapterLogger, DnsAdapter, DnsRecord, DomainInfo, PageResult, resolveDomainIdHelper } from '../internal';
import { buildAuthHeaders, type GcoreAuthConfig } from './auth';
import { requestJson } from '../http';
export const DEFAULT_LINE = '0';

const log = createProviderAdapterLogger('Gcore');
interface GcoreZone {
  id: number;
  name: string;
}

interface GcoreRRSet {
  name: string;
  type: string;
  ttl?: number;
  resource_records: Array<{
    content: string[];
    enabled?: boolean;
  }>;
  filter_set_id?: number;
  meta?: Record<string, unknown>;
  pickers?: Array<{
    type: string;
    limit?: number;
    strict?: boolean;
  }>;
  updated_at?: string;
  warning?: string;
  warnings?: Array<{ key: string; message: string }>;
}

interface GcoreApiResponse<T> {
  success?: boolean;
  result?: T;
  results?: T[];
  total?: number;
  total_amount?: number;
  zones?: T[];
  rrsets?: T[];
  error?: string;
  errors?: Array<{ message: string }>;
}

function parseGcoreError(payload: unknown): string | undefined {
  const data = payload as GcoreApiResponse<unknown>;
  if (data?.errors?.length) return data.errors[0].message;
  if (data?.error) return data.error;
  return undefined;
}

export class GcoreAdapter implements DnsAdapter {
  private config: GcoreAuthConfig;
  private error: string = '';
  private baseUrl = 'https://api.gcore.com/dns/v2';

  constructor(config: GcoreAuthConfig) {
    this.config = config;
  }

  /** Gcore API 使用完整主机名，需要将子域名转为完整主机名 */
  private toFullName(name: string): string {
    const zoneName = this.zoneName;
    if (!zoneName) return name;
    if (name === '@' || name === '' || name === zoneName) return zoneName;
    // 如果已经是完整主机名（以 zoneName 结尾），直接返回
    if (name === zoneName || name.endsWith(`.${zoneName}`)) return name;
    return `${name}.${zoneName}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<GcoreApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    log.sub('API').tag('REQUEST').debug('Provider request', { method: method, url: url, params: body });

    try {
      const raw = await requestJson<GcoreApiResponse<T>>(url, {
        method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        headers: buildAuthHeaders(this.config),
        body: body ? JSON.stringify(body) : undefined,
        useProxy: this.config.useProxy ?? false,
        providerName: 'Gcore',
        parseError: parseGcoreError,
      });
      const data: GcoreApiResponse<T> = Array.isArray(raw) ? { results: raw, total: raw.length } : (raw ?? {});
      log.sub('API').tag('RESPONSE').debug('Provider response', { status: 200, success: true, data: {
        hasResult: !!data.zones || !!data.rrsets || !!data.result || !!data.results,
        total: data.total_amount ?? data.total,
      } });
      return data;
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      this.error = errorMessage;
      log.sub('API').tag('ERROR').error('Provider error', { error: errorMessage });
      return {} as GcoreApiResponse<T>;
    }
  }

  getError(): string {
    return this.error;
  }

  private async resolveDomainId(): Promise<string | null> {
    return resolveDomainIdHelper(this.config, this.getDomainList.bind(this), 'Gcore');
  }

  private get zoneName(): string | undefined {
    return this.config.domain;
  }

  async check(): Promise<boolean> {
    this.error = '';
    await this.request<GcoreZone[]>('GET', '/zones?limit=1');
    return !this.error;
  }

  async getDomainList(keyword?: string, page = 1, pageSize = 50): Promise<PageResult<DomainInfo>> {
    const offset = (page - 1) * pageSize;
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(offset),
    });

    if (keyword) {
      params.set('name', keyword);
    }

    this.error = '';
    const res = await this.request<any>('GET', `/zones?${params.toString()}`);

    if (this.error) {
      throw new Error(`Gcore API error: ${this.error}`);
    }

    const zones: any[] = Array.isArray(res.zones) ? res.zones : [];
    const list = zones.map((zone: any) => ({
      Domain: zone.name,
      ThirdId: String(zone.id),
      RecordCount: 0,
    }));

    return { total: res.total_amount ?? list.length, list };
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
      const zoneName = this.zoneName;
      if (!zoneName) {
        this.error = this.error || '读取记录失败：未解析到域名或上游返回空结果';
        return { total: 0, list: [] };
      }

      const offset = (page - 1) * pageSize;
      const params = new URLSearchParams({
        limit: String(pageSize),
        offset: String(offset),
      });

      if (type) {
        params.set('type', type);
      }

      const res = await this.request<any>('GET', `/zones/${zoneName}/rrsets?${params.toString()}`);

      let rrsets: any[] = Array.isArray(res.rrsets) ? res.rrsets : [];

      if (subdomain) {
        const lowerSubdomain = subdomain.toLowerCase();
        rrsets = rrsets.filter((rrset: any) => {
          const recordName = rrset.name.toLowerCase();
          // rrset.name 是完整主机名，subdomain 是子域名（如 www），需要转换比较
          const subName = recordName === zoneName ? '@' : recordName.replace(`.${zoneName}`, '');
          return subName === lowerSubdomain || subName.endsWith(`.${lowerSubdomain}`);
        });
      }

      if (keyword) {
        const lowerKeyword = keyword.toLowerCase();
        rrsets = rrsets.filter((rrset: any) =>
          rrset.name.toLowerCase().includes(lowerKeyword) ||
          rrset.resource_records.some((rr: any) =>
            rr.content.some((c: string) => c.toLowerCase().includes(lowerKeyword))
          )
        );
      }

      if (value) {
        rrsets = rrsets.filter((rrset: any) =>
          rrset.resource_records.some((rr: any) => rr.content.includes(value))
        );
      }

      const rawList = rrsets.flatMap((rrset) => this.mapRRSetToRecords(rrset, zoneName));
      const list = rawList.filter(r => {
        if (r.Type !== 'NS') return true;
        // 只过滤 @ 记录的 NS（托管商默认 NS），保留子域名 NS 记录（DNS 委派）
        if (r.Name !== '@') return true;
        const v = r.Value.toLowerCase();
        return !v.endsWith('.gcorelabs.net') && !v.endsWith('.gcore-dns.com') && !v.endsWith('.gcdn.services');
      });

      return { total: res.total_amount ?? list.length, list };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return { total: 0, list: [] };
    }
  }

  private mapRRSetToRecords(rrset: GcoreRRSet, zoneName: string): DnsRecord[] {
    const records: DnsRecord[] = [];

    rrset.resource_records.forEach((rr, i) => {
      if (!rr.enabled && rr.enabled !== undefined) return;

      const content = rr.content;
      let value = '';
      let mx = 0;
      let weight = undefined;

      switch (rrset.type.toUpperCase()) {
        case 'SRV':
          if (content.length >= 4) {
            mx = Number(content[0]) || 0;
            weight = Number(content[1]) || 0;
            value = `${content[0]} ${content[1]} ${content[2]} ${content[3]}`;
          }
          break;
        case 'MX':
          if (content.length >= 2) {
            mx = Number(content[0]) || 0;
            value = content[1];
          }
          break;
        default:
          value = content[0] || '';
      }

      records.push({
        RecordId: `${zoneName}:${rrset.name}:${rrset.type}:${i}`,
        Domain: zoneName,
        Name: rrset.name === zoneName ? '@' : rrset.name.replace(`.${zoneName}`, ''),
        Type: rrset.type.toUpperCase(),
        Value: value,
        Line: '0',
        TTL: rrset.ttl || 3600,
        MX: mx,
        Status: 1,
        Weight: weight,
        Remark: undefined,
        UpdateTime: rrset.updated_at,
      });
    });

    return records;
  }

  async getDomainRecordInfo(recordId: string): Promise<DnsRecord | null> {
    try {
      const zoneName = this.zoneName;
      if (!zoneName) return null;

      const parts = recordId.split(':');
      if (parts.length < 3) return null;

      const [, name, type] = parts;
      const res = await this.request<any>('GET', `/zones/${zoneName}/${name}/${type}`);

      const rrsets: any[] = Array.isArray(res.rrsets) ? res.rrsets : [];
      if (rrsets.length === 0) return null;

      const records = this.mapRRSetToRecords(rrsets[0] as GcoreRRSet, zoneName);
      return records[0] || null;
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
    ttl = 3600,
    mx = 1,
    weight?: number,
    remark?: string
  ): Promise<string | null> {
    try {
      const zoneName = this.zoneName;
      if (!zoneName) return null;

      let content: string[];
      switch (type.toUpperCase()) {
        case 'SRV':
          const srvParts = value.split(/\s+/);
          content = [
            String(mx),
            String(weight || 0),
            srvParts[0] || '0',
            srvParts.slice(1).join(' ') || '',
          ];
          break;
        case 'MX':
          content = [String(mx), value];
          break;
        default:
          content = [value];
      }

      const body = {
        resource_records: [{ content }],
        ttl,
      };

      const fullName = this.toFullName(name);
      await this.request<GcoreRRSet>('POST', `/zones/${zoneName}/${fullName}/${type.toUpperCase()}`, body);

      return `${zoneName}:${fullName}:${type.toUpperCase()}`;
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
    ttl = 3600,
    mx = 1,
    weight?: number,
    remark?: string
  ): Promise<boolean> {
    try {
      const zoneName = this.zoneName;
      if (!zoneName) return false;

      let content: string[];
      switch (type.toUpperCase()) {
        case 'SRV':
          const srvParts = value.split(/\s+/);
          content = [
            String(mx),
            String(weight || 0),
            srvParts[0] || '0',
            srvParts.slice(1).join(' ') || '',
          ];
          break;
        case 'MX':
          content = [String(mx), value];
          break;
        default:
          content = [value];
      }

      const body = {
        resource_records: [{ content }],
        ttl,
      };

      const fullName = this.toFullName(name);
      await this.request<GcoreRRSet>('PUT', `/zones/${zoneName}/${fullName}/${type.toUpperCase()}`, body);

      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    try {
      const zoneName = this.zoneName;
      if (!zoneName) return false;

      const parts = recordId.split(':');
      if (parts.length < 3) return false;

      const [, name, type] = parts;

      await this.request('DELETE', `/zones/${zoneName}/${name}/${type}`);

      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async setDomainRecordStatus(recordId: string, status: number): Promise<boolean> {
    try {
      const zoneName = this.zoneName;
      if (!zoneName) return false;

      const parts = recordId.split(':');
      if (parts.length < 3) return false;

      const [, name, type] = parts;

      const res = await this.request<any>('GET', `/zones/${zoneName}/${name}/${type}`);

      const rrsets: any[] = Array.isArray(res.rrsets) ? res.rrsets : [];
      if (rrsets.length === 0) return false;

      const rrset = rrsets[0];
      const updatedRecords = (rrset.resource_records || []).map((rr: any) => ({
        ...rr,
        enabled: status === 1,
      }));

      await this.request<GcoreRRSet>('PUT', `/zones/${zoneName}/${name}/${type}`, {
        resource_records: updatedRecords,
        ttl: rrset.ttl,
      });

      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    // Gcore 仅使用默认线路，禁用动态线路注册
    // 如需启用，取消注释下方代码
    // try {
    //   const res: any = await this.request('GET', '/locations');
    //   const lines: Array<{ id: string; name: string }> = [{ id: '0', name: '默认' }];
    //   const extract = (v: unknown): string => {
    //     if (typeof v === 'string') return v;
    //     if (v && typeof v === 'object') {
    //       const obj = v as any;
    //       if (obj.names) {
    //         if (typeof obj.names === 'string') return obj.names;
    //         return obj.names['zh-CN'] || obj.names.en || obj.names.zh || Object.values(obj.names).find((n: any) => typeof n === 'string') || String(obj.names);
    //       }
    //       const fallback = obj.name || obj.labelEn || obj;
    //       if (typeof fallback === 'string') return fallback;
    //       if (fallback && typeof fallback === 'object') return fallback.en || fallback.labelEn || fallback.zh || fallback.labelZh || String(fallback);
    //       return String(fallback);
    //     }
    //     return String(v);
    //   };
    //   if (res.continents) {
    //     for (const [id, name] of Object.entries(res.continents))
    //       lines.push({ id: `continent:${id}`, name: `[洲] ${extract(name)}` });
    //   }
    //   if (res.countries) {
    //     for (const [id, name] of Object.entries(res.countries))
    //       lines.push({ id: `country:${id}`, name: `[国家] ${extract(name)}` });
    //   }
    //   if (res.regions) {
    //     for (const [id, name] of Object.entries(res.regions))
    //       lines.push({ id: `region:${id}`, name: `[地区] ${extract(name)}` });
    //   }
    //   return lines;
    // } catch {
    //   return [{ id: '0', name: '默认' }];
    // }
    return [{ id: '0', name: '默认' }];
  }

  async getMinTTL(): Promise<number> {
    return 60;
  }

  async addDomain(domain: string): Promise<boolean> {
    try {
      await this.request('POST', '/zones', { name: domain });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }
}