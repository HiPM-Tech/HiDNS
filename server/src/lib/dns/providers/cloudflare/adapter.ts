import { createProviderAdapterLogger, DnsAdapter, DnsRecord, DomainInfo, PageResult, resolveDomainIdHelper } from '../internal';
import { buildAuthHeaders, authenticatedRequest, type CloudflareAuthConfig } from './auth';

const log = createProviderAdapterLogger('Cloudflare');
interface CfZone {
  id: string;
  name: string;
  status: string;
  meta?: { total_count?: number };
}

interface CfRecord {
  id: string;
  zone_name: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
  proxiable?: boolean;
  ttl: number;
  priority?: number;
  weight?: number;
  data?: {
    service?: string;
    proto?: string;
    name?: string;
    priority?: number;
    weight?: number;
    port?: number;
    target?: string;
  };
  comment?: string;
  modified_on?: string;
}

interface CfApiResponse<T> {
  success: boolean;
  result: T;
  result_info?: { total_count: number; count: number; page: number; per_page: number };
  errors?: Array<{ message: string }>;
}

export class CloudflareAdapter implements DnsAdapter {
  private config: CloudflareAuthConfig;
  private error: string = '';
  private baseUrl = 'https://api.cloudflare.com/client/v4';

  constructor(config: CloudflareAuthConfig) {
    this.config = config;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<CfApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    log.sub('API').tag('REQUEST').debug('Provider request', { method: method, url: url, params: body });

    const options: RequestInit = {
      method,
      body: body ? JSON.stringify(body) : undefined,
    };

    // authenticatedRequest 会自动添加授权头
    const res = await authenticatedRequest(url, this.config, options);
    const data = (await res.json()) as CfApiResponse<T>;
    log.sub('API').tag('RESPONSE').debug('Provider response', { status: res.status, success: data.success, data: { resultCount: Array.isArray(data.result) ? data.result.length : 0 } });
    if (!data.success) {
      // Log detailed error information
      if (data.errors?.length) {
        this.error = data.errors[0].message;
        log.sub('API').tag('ERROR').error('Provider error', {
          status: res.status,
          errors: data.errors.map((e) => e.message),
        });
      } else if (res.status === 404) {
        this.error = `Resource not found (404): ${path}`;
        log.sub('API').tag('ERROR').error('Provider error', {
          status: 404,
          path,
          message: 'Zone or record not found',
          zoneId: this.config.zoneId,
          domain: this.config.domain
        });
      } else {
        this.error = `API request failed with status ${res.status}`;
        log.sub('API').tag('ERROR').error('Provider error', { status: res.status, path });
      }
    }
    return data;
  }

  async check(): Promise<boolean> {
    try {
      const res = await this.request<CfZone[]>('GET', '/zones?per_page=1');
      if (!res.success) return false;
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  getError(): string {
    return this.error;
  }

  /**
   * 验证 Zone ID 是否有效
   */
  private async validateZone(zoneId: string): Promise<boolean> {
    try {
      log.debug(`Validating zone: ${zoneId}`);
      const res = await this.request<CfZone>('GET', `/zones/${zoneId}`);
      if (!res.success) {
        log.warn(`Zone validation failed:`, res.errors);
        return false;
      }
      log.debug(`Zone validated successfully: ${res.result.name} (${zoneId})`);
      return true;
    } catch (e) {
      log.error(`Zone validation error:`, e);
      return false;
    }
  }

  /**
   * 根据域名查找 Zone ID
   * 当 config.zoneId 未设置时，尝试通过域名搜索获取
   */
  private async resolveZoneId(): Promise<string | null> {
    log.debug(`resolveZoneId called. Current config:`, {
      zoneId: this.config.zoneId,
      domainId: (this.config as any).domainId,
      domain: this.config.domain
    });

    // 如果已有 zoneId，先验证其格式是否正确
    const existingZoneId = this.config.zoneId || (this.config as any).domainId;
    if (existingZoneId) {
      // Cloudflare Zone ID 应该是 32 或 40 位的十六进制字符串
      // 如果是 32 位且看起来像 MD5（全部小写），可能需要重新获取
      const isValidFormat = /^[a-f0-9]{32,40}$/i.test(existingZoneId);
      if (!isValidFormat) {
        log.warn(`Existing zoneId has invalid format: ${existingZoneId}. Will attempt to fetch from API.`);
        // 清除无效的 zoneId，强制重新获取
        this.config.zoneId = undefined;
        (this.config as any).domainId = undefined;
      }
    }

    return resolveDomainIdHelper(this.config, this.getDomainList.bind(this), 'Cloudflare');
  }

  async getDomainList(keyword?: string, page = 1, pageSize = 50): Promise<PageResult<DomainInfo>> {
    let path = `/zones?page=${page}&per_page=${pageSize}&status=active`;
    if (keyword) path += `&name=${encodeURIComponent(keyword)}`;
    log.debug(`getDomainList: page=${page}, pageSize=${pageSize}, keyword=${keyword || 'none'}`);
    const res = await this.request<CfZone[]>('GET', path);
    if (!res.success) {
      this.error = 'Cloudflare API returned success=false';
      log.error('getDomainList failed', res.errors);
      return { total: 0, list: [] };
    }
    this.error = '';
    const activeZones = res.result.filter(z => z.status === 'active');
    const total = res.result_info?.total_count ?? res.result.length;
    log.debug(`getDomainList success: total=${total}, active=${activeZones.length}, returned=${res.result.length}`);
    return {
      total,
      list: activeZones.map((z) => ({
        Domain: z.name,
        ThirdId: z.id,
        RecordCount: undefined,
      })),
    };
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
    const zoneId = await this.resolveZoneId();
    log.debug(`getDomainRecords: zoneId=${zoneId || 'null'}, domain=${this.config.domain}, page=${page}, pageSize=${pageSize}`);
    if (!zoneId) {
      log.warn(`getDomainRecords: zoneId is null, returning empty result. Config:`, {
        zoneId: this.config.zoneId,
        domainId: (this.config as any).domainId,
        domain: this.config.domain
      });
      this.error = this.error || '读取记录失败：未解析到域名或上游返回空结果';
      return { total: 0, list: [] };
    }

    // 先验证 Zone ID 是否有效
    log.debug(`Validating zoneId: ${zoneId} for domain: ${this.config.domain}`);
    const zoneValid = await this.validateZone(zoneId);
    if (!zoneValid) {
      log.error(`Zone validation failed for zoneId: ${zoneId}. The zone may not exist or API token may lack permissions.`);
      this.error = `Zone validation failed. Please check if zoneId '${zoneId}' is correct and API token has proper permissions.`;
      this.error = this.error || '读取记录失败：未解析到域名或上游返回空结果';
      return { total: 0, list: [] };
    }

    let path = `/zones/${zoneId}/dns_records?page=${page}&per_page=${pageSize}`;
    if (type) path += `&type=${encodeURIComponent(type)}`;
    // Cloudflare requires full record name for filtering (including zone name).
    if (subdomain) {
      try {
        path += `&name=${encodeURIComponent(this.toFqdnRecordName(subdomain))}`;
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
      }
    }
    if (value) path += `&content=${encodeURIComponent(value)}`;
    if (keyword) path += `&search=${encodeURIComponent(keyword)}`;

    const res = await this.request<CfRecord[]>('GET', path);
    if (!res.success) { this.error = this.error || '读取记录失败：未解析到域名或上游返回空结果'; return { total: 0, list: [] }; }
    const total = res.result_info?.total_count ?? res.result.length;
    return {
      total,
      list: res.result.map((r) => this.mapRecord(r)),
    };
  }

  async getDomainRecordInfo(recordId: string): Promise<DnsRecord | null> {
    const zoneId = await this.resolveZoneId();
    if (!zoneId) return null;
    const res = await this.request<CfRecord>('GET', `/zones/${zoneId}/dns_records/${recordId}`);
    if (!res.success) return null;
    return this.mapRecord(res.result);
  }

  async addDomainRecord(
    name: string,
    type: string,
    value: string,
    line?: string,
    ttl = 1,
    mx = 0,
    weight?: number,
    remark?: string
  ): Promise<string | null> {
    try {
      const zoneId = await this.resolveZoneId();
      if (!zoneId) return null;
      const body = this.buildRecordBody(name, type, value, line, ttl, mx, weight, remark);
      const res = await this.request<CfRecord>('POST', `/zones/${zoneId}/dns_records`, body);
      if (!res.success) return null;
      return res.result.id;
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
    ttl = 1,
    mx = 0,
    weight?: number,
    remark?: string
  ): Promise<boolean> {
    try {
      const zoneId = await this.resolveZoneId();
      if (!zoneId) return false;
      const body = this.buildRecordBody(name, type, value, line, ttl, mx, weight, remark);
      const res = await this.request<CfRecord>('PATCH', `/zones/${zoneId}/dns_records/${recordId}`, body);
      return res.success;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    const zoneId = await this.resolveZoneId();
    if (!zoneId) return false;
    const res = await this.request<{ id: string }>('DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
    return res.success;
  }

  async setDomainRecordStatus(recordId: string, status: number): Promise<boolean> {
    // Cloudflare has no native enable/disable for DNS records.
    // We emulate pause by renaming the record with a reversible suffix.
    const info = await this.getDomainRecordInfo(recordId);
    if (!info) return false;
    if (info.Status === status) return true;

    const baseName = this.decodePausedRecordName(info.Name);
    const nextName = status === 0 ? this.encodePausedRecordName(baseName) : baseName;
    return this.updateDomainRecord(recordId, nextName, info.Type, info.Value, info.Line, info.TTL, info.MX, info.Weight, info.Remark);
  }

  getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    return Promise.resolve([{ id: '0', name: '默认' }]);
  }

  getMinTTL(): Promise<number> {
    return Promise.resolve(1);
  }

  async addDomain(domain: string): Promise<boolean> {
    const res = await this.request<CfZone>('POST', '/zones', {
      name: domain,
      jump_start: false,
    });
    return res.success;
  }

  private mapRecord(r: CfRecord): DnsRecord {
    const zoneName = this.getZoneName(r);
    const normalizedManaged = this.normalizeManagedRecordName(r.name, zoneName);
    const displayName = normalizedManaged.name;
    const isPaused = normalizedManaged.paused;
    const srvValue = r.data?.port !== undefined && r.data?.target
      ? `${r.data.port} ${r.data.target}`
      : this.safeString(r.content);

    return {
      RecordId: this.safeString(r.id),
      Domain: zoneName,
      Name: displayName || '@',
      Type: this.safeString(r.type),
      Value: srvValue,
      Line: r.proxied ? '1' : '0',
      TTL: r.ttl ?? 1,
      MX: r.data?.priority ?? r.priority ?? 0,
      Status: isPaused ? 0 : 1,
      Proxiable: r.proxiable ?? false,
      Cloudflare: {
        proxied: Boolean(r.proxied),
        proxiable: r.proxiable ?? false,
      },
      // Cloudflare exposes weight only for certain record types (e.g. SRV/URI via `data`).
      Weight: r.data?.weight,
      Remark: r.comment,
      UpdateTime: r.modified_on,
    };
  }

  private buildRecordBody(
    name: string,
    type: string,
    value: string,
    line: string | undefined,
    ttl: number,
    mx = 0,
    weight?: number,
    remark?: string
  ): Record<string, unknown> {
    const fqdnName = this.toFqdnRecordName(name);

    if (type === 'SRV') {
      const srv = this.parseSrvRecord(name, value, mx, weight);
      const body: Record<string, unknown> = { name: fqdnName, type, ttl, data: srv };
      const proxied = this.toProxiedValue(line);
      if (proxied !== undefined) body['proxied'] = proxied;
      if (remark !== undefined) body['comment'] = remark;
      return body;
    }

    const body: Record<string, unknown> = { name: fqdnName, type, content: value, ttl };
    const proxied = this.toProxiedValue(line);
    if (proxied !== undefined) body['proxied'] = proxied;
    if (type === 'MX') body['priority'] = mx;
    // Cloudflare DNS records do not support a generic "weight" field for most types.
    if (remark !== undefined) body['comment'] = remark;
    return body;
  }

  private parseSrvRecord(_name: string, value: string, priority = 0, weight = 0) {
    const valueParts = value.trim().split(/\s+/).filter(Boolean);
    const port = Number(valueParts[0] ?? 0);
    const target = valueParts.slice(1).join(' ');

    return {
      priority,
      weight,
      port,
      target,
    };
  }

  private toFqdnRecordName(name: string): string {
    const zoneName = this.safeString(this.config.domain).replace(/\.$/, '');
    const normalized = this.safeString(name).replace(/\.$/, '');

    // Cloudflare API expects a fully-qualified record name including the zone name.
    if (!normalized || normalized === '@') {
      if (!zoneName) {
        throw new Error('Cloudflare: config.domain is required to use @ record name');
      }
      return zoneName;
    }

    // Already looks like a FQDN.
    if (!zoneName) return normalized;
    if (normalized === zoneName) return zoneName;

    const suffix = `.${zoneName}`;
    return normalized.endsWith(suffix) ? normalized : `${normalized}${suffix}`;
  }

  private toProxiedValue(line?: string): boolean | undefined {
    if (line === '1') return true;
    if (line === '0') return false;
    return undefined;
  }

  private toRelativeRecordName(name: string, zoneName: string): string {
    const normalizedName = this.safeString(name).replace(/\.$/, '');
    const normalizedZone = this.safeString(zoneName).replace(/\.$/, '');
    if (!normalizedName || !normalizedZone) return normalizedName;
    if (normalizedName === normalizedZone) return '@';
    const suffix = `.${normalizedZone}`;
    return normalizedName.endsWith(suffix)
      ? normalizedName.slice(0, -suffix.length)
      : normalizedName;
  }

  private isPausedRecordName(name: string): boolean {
    return (
      name === '_cloud_paused' ||
      name.endsWith('_cloud_paused')
    );
  }

  private decodePausedRecordName(name: string): string {
    if (name === '_cloud_paused') return '@';
    if (name.endsWith('_cloud_paused')) {
      return name.slice(0, -'_cloud_paused'.length);
    }
    return name;
  }

  private encodePausedRecordName(name: string): string {
    const normalized = this.decodePausedRecordName(name);
    return normalized === '@' ? '_cloud_paused' : `${normalized}_cloud_paused`;
  }

  private normalizeManagedRecordName(name: string, zoneName: string): { name: string; paused: boolean } {
    let current = this.safeString(name).replace(/\.$/, '');
    const normalizedZone = this.safeString(zoneName).replace(/\.$/, '');
    let paused = false;

    if (!current) {
      return { name: '@', paused: false };
    }

    for (let i = 0; i < 6; i++) {
      const relative = this.toRelativeRecordName(current, normalizedZone);
      paused = paused || this.isPausedRecordName(relative);

      let next = this.decodePausedRecordName(relative);
      if (next === normalizedZone) next = '@';

      if (next === current) break;
      current = next;
    }

    return { name: current, paused };
  }

  private getZoneName(record?: Pick<CfRecord, 'zone_name'>): string {
    return this.safeString(record?.zone_name) || this.safeString(this.config.domain);
  }

  private safeString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }
}
