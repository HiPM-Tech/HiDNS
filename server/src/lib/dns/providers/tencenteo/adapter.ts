import { createProviderAdapterLogger, DnsRecord, DomainInfo, PageResult, asArray, buildSrvValue, Dict, isSrv, normalizeRrName, parseSrvValue, safeString, TencentCloudAdapter, toNumber } from '../internal';
import { OriginGroupClient } from './origin-group-client';

const log = createProviderAdapterLogger('TencentEO');
export class TencenteoAdapter extends TencentCloudAdapter {
  private zoneId: string = '';
  private domain: string = '';
  private readonly siteType: string;

  constructor(config: Record<string, string>) {
    super(config);
    this.siteType = safeString(config.site_type).toLowerCase();
  }

  protected service(): string {
    return 'teo';
  }

  protected endpoint(): string {
    return this.siteType === 'intl' ? 'teo.intl.tencentcloudapi.com' : 'teo.tencentcloudapi.com';
  }

  protected version(): string {
    return '2022-09-01';
  }

  /**
   * 设置当前操作的 Zone ID 和域名
   * 在获取记录、添加记录等操作前调用
   */
  setZoneInfo(zoneId: string, domain: string): void {
    this.zoneId = zoneId;
    this.domain = domain;
    log.debug('ZoneInfo set', { zoneId, domain });
  }

  /** 源站组裸原语（不做定位/保留/校验，保护在能力层） */
  originGroups(): OriginGroupClient {
    return new OriginGroupClient((action, payload) => this.call(action, payload), this.zoneId);
  }

  /**
   * 按域名反查 EdgeOne ZoneId。
   *
   * 用途：DNSPod 账号下的 `domains.third_id` 是 DNSPod 的域名 ID，不是 EO 的 ZoneId。
   * 复用同一对腾讯云密钥调用 TEO 时，只能拿域名去 TEO 侧反查。
   * 匹配用**精确等值**（忽略大小写），不做后缀/模糊匹配 —— 否则
   * `a.example.com` 可能被 `example.com` 命中，写到别人的站点上。
   */
  async resolveZoneIdByName(zoneName: string): Promise<string | null> {
    const target = safeString(zoneName).trim().toLowerCase();
    if (!target) return null;
    const limit = 100;
    for (let offset = 0; offset < 1000; offset += limit) {
      const res = await this.call<Dict>('DescribeZones', { Limit: limit, Offset: offset });
      const zones = asArray<Dict>(res?.Zones);
      const hit = zones.find((zone) => safeString(zone.ZoneName).trim().toLowerCase() === target);
      if (hit) return safeString(hit.ZoneId) || null;
      const total = toNumber(res?.TotalCount, 0);
      if (zones.length < limit || offset + zones.length >= total) break;
    }
    return null;
  }

  private fqdn(name: string): string {
    const rr = normalizeRrName(name);
    return rr === '@' ? this.domain : `${rr}.${this.domain}`;
  }

  private rrFromFqdn(name: string): string {
    const normalized = safeString(name);
    if (!this.domain) return normalizeRrName(normalized);
    if (normalized === this.domain) return '@';
    const suffix = `.${this.domain}`;
    if (normalized.endsWith(suffix)) {
      const rr = normalized.slice(0, -suffix.length);
      return rr || '@';
    }
    return normalizeRrName(normalized);
  }

  private mapRecord(item: Dict): DnsRecord {
    const type = safeString(item.Type);
    const value = isSrv(type)
      ? buildSrvValue(item.Port, item.Content, item.Content)
      : safeString(item.Content) || safeString(item.Value);

    return {
      RecordId: String(item.RecordId ?? ''),
      Domain: this.domain || safeString(item.ZoneName),
      Name: this.rrFromFqdn(safeString(item.Name)),
      Type: type,
      Value: value,
      Line: safeString(item.Location) || 'Default',
      TTL: toNumber(item.TTL, 60),
      MX: toNumber(item.Priority, 0),
      Status: safeString(item.Status).toLowerCase() === 'enable' ? 1 : 0,
      Weight: item.Weight === undefined || toNumber(item.Weight, -1) === -1 ? undefined : toNumber(item.Weight, 0),
      Remark: undefined,
      UpdateTime: safeString(item.ModifiedOn) || undefined,
    };
  }

  async check(): Promise<boolean> {
    try {
      await this.call('DescribeZones', { Offset: 0, Limit: 1, Filters: [{ Name: 'zone-type', Values: ['full'] }] });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async getDomainList(keyword?: string, page = 1, pageSize = 50): Promise<PageResult<DomainInfo>> {
    try {
      const offset = (page - 1) * pageSize;
      const filters: Array<{ Name: string; Values: string[] }> = [{ Name: 'zone-type', Values: ['full'] }];
      if (keyword) filters.push({ Name: 'zone-name', Values: [keyword] });
      const data = await this.call<Dict>('DescribeZones', { Offset: offset, Limit: pageSize, Filters: filters });
      const list = asArray<Dict>(data.Zones).map((zone) => ({
        Domain: safeString(zone.ZoneName),
        ThirdId: safeString(zone.ZoneId),
        RecordCount: 0,
      }));
      return { total: toNumber(data.TotalCount, list.length), list };
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
      log.debug('getDomainRecords called', { zoneId: this.zoneId, domain: this.domain, page, pageSize });
      if (!this.zoneId) {
        this.error = 'Zone ID not set';
        log.warn('Zone ID not set when getting domain records', { domain: this.domain });
        return { total: 0, list: [] };
      }
      const offset = (page - 1) * pageSize;
      const filters: Array<{ Name: string; Values: string[]; Fuzzy?: boolean }> = [];
      if (subdomain) filters.push({ Name: 'name', Values: [this.fqdn(subdomain)] });
      else if (keyword) filters.push({ Name: 'name', Values: [this.fqdn(keyword)] });
      if (value) filters.push({ Name: 'content', Values: [value], Fuzzy: true });
      if (type) filters.push({ Name: 'type', Values: [type] });

      const data = await this.call<Dict>('DescribeDnsRecords', {
        ZoneId: this.zoneId,
        Offset: offset,
        Limit: pageSize,
        Filters: filters,
      });
      const list = asArray<Dict>(data.DnsRecords).map((item) => this.mapRecord(item));
      return { total: toNumber(data.TotalCount, list.length), list };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return { total: 0, list: [] };
    }
  }

  async getDomainRecordInfo(recordId: string): Promise<DnsRecord | null> {
    try {
      if (!this.zoneId) {
        this.error = 'Zone ID not set';
        return null;
      }
      const data = await this.call<Dict>('DescribeDnsRecords', {
        ZoneId: this.zoneId,
        Filters: [{ Name: 'id', Values: [recordId] }],
      });
      const row = asArray<Dict>(data.DnsRecords)[0];
      return row ? this.mapRecord(row) : null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  async addDomainRecord(name: string, type: string, value: string, line?: string, ttl = 600, mx = 1, weight?: number, _remark?: string): Promise<string | null> {
    try {
      if (!this.zoneId) {
        this.error = 'Zone ID not set';
        return null;
      }
      const srv = parseSrvValue(value);
      const data = await this.call<Dict>('CreateDnsRecord', {
        ZoneId: this.zoneId,
        Name: this.fqdn(name),
        Type: type,
        Content: isSrv(type) ? srv.target : value,
        Location: line || 'Default',
        TTL: ttl,
        Priority: type === 'MX' ? mx : undefined,
        Weight: weight === undefined ? -1 : weight,
        Port: isSrv(type) ? srv.port : undefined,
      });
      return safeString(data.RecordId) || null;
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
      if (!this.zoneId) {
        this.error = 'Zone ID not set';
        return false;
      }
      const srv = parseSrvValue(value);
      await this.call('ModifyDnsRecord', {
        ZoneId: this.zoneId,
        DnsRecordId: recordId,
        Name: this.fqdn(name),
        Type: type,
        Content: isSrv(type) ? srv.target : value,
        Location: line || 'Default',
        TTL: ttl,
        Priority: type === 'MX' ? mx : undefined,
        Weight: weight === undefined ? -1 : weight,
        Port: isSrv(type) ? srv.port : undefined,
      });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    try {
      if (!this.zoneId) {
        this.error = 'Zone ID not set';
        return false;
      }
      await this.call('DeleteDnsRecords', {
        ZoneId: this.zoneId,
        RecordIds: [recordId],
      });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async setDomainRecordStatus(recordId: string, status: number): Promise<boolean> {
    try {
      if (!this.zoneId) {
        this.error = 'Zone ID not set';
        return false;
      }
      await this.call('ModifyDnsRecordsStatus', {
        ZoneId: this.zoneId,
        RecordsToEnable: status === 1 ? [recordId] : undefined,
        RecordsToDisable: status === 0 ? [recordId] : undefined,
      });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    // 腾讯 EO 支持大陆/非大陆线路
    return [
      { id: 'Default', name: '默认' },
      { id: 'Mainland', name: '中国大陆' },
      { id: 'Overseas', name: '非中国大陆' },
    ];
  }

  async getMinTTL(): Promise<number> {
    return 60;
  }

  async addDomain(_domain: string): Promise<boolean> {
    return false;
  }
}
