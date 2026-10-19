import type { DnsAdapter, DnsRecord, DomainInfo, PageResult } from '../../DnsInterface';
import { OriginGroupClient } from '../tencenteo/origin-group-client';
import { VirtualStore, type VirtualDnsRecord, type VirtualZone } from './store';
import { createVirtualTeoCall } from './origin-api';
import { isVirtualProviderEnabled, virtualProviderDisabledReason } from '../availability';

/**
 * 虚拟 DNS 提供商。
 *
 * 用途：在不交出任何真实域名解析凭证的前提下，完整演练 HiDNS 的工作流能力。
 * 因此它实现的是**完整的提供商契约**（域名、解析记录、源站组），
 * 而不是一个只会返回固定值的桩。
 *
 * 启用方式：账号配置里必须显式给 `virtual_enabled=true`（默认关闭，失败关闭）。
 * 另有进程级硬开关 `HIDNS_DISABLE_VIRTUAL_PROVIDER=1`，生产可一键停用。
 */

const MIN_TTL = 60;
const DEFAULT_TTL = 60;

export interface VirtualAdapterConfig {
  [key: string]: string | undefined;
  virtual_enabled?: string;
  virtual_tenant?: string;
  virtual_state?: string;
  virtual_seed?: string;
  virtual_state_dir?: string;
}

function truthy(value: unknown): boolean {
  return String(value ?? '').toLowerCase() === 'true';
}

/** 环境开关：1 / true / yes / on 都算开启，避免运维写成 1 却静默失效 */
function envFlag(value: unknown): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

export class VirtualAdapter implements DnsAdapter {
  private readonly store: VirtualStore;
  private readonly enabled: boolean;
  private readonly tenant: string;
  private domainName: string;
  private zoneId: string;
  private lastError = '';

  constructor(config: VirtualAdapterConfig) {
    const killed = envFlag(process.env.HIDNS_DISABLE_VIRTUAL_PROVIDER);
    this.enabled = !killed && isVirtualProviderEnabled() && truthy(config.virtual_enabled);
    this.tenant = String(config.virtual_tenant ?? 'default') || 'default';
    this.domainName = String(config.domain ?? '');
    this.zoneId = String(config.zoneId ?? '');
    this.store = new VirtualStore(this.tenant, {
      persistent: String(config.virtual_state ?? 'file') !== 'memory',
      seed: String(config.virtual_seed ?? 'demo') === 'empty' ? 'empty' : 'demo',
      filePath: config.virtual_state_dir ? `${config.virtual_state_dir}/${this.tenant}.json` : undefined,
    });
  }

  /** 由适配器工厂在拿到域名上下文后注入 */
  setZoneInfo(zoneId: string, domain: string): void {
    this.zoneId = zoneId || this.zoneId;
    if (domain) this.domainName = domain;
  }

  private ensureEnabled(): void {
    // 第一道：进程级可用性。生产永远过不去，即使账号里写了 virtual_enabled=true
    if (!isVirtualProviderEnabled()) {
      throw new Error(virtualProviderDisabledReason());
    }
    if (!this.enabled) {
      throw new Error('虚拟提供商未启用：账号配置需显式设置 virtual_enabled=true');
    }
  }

  private zone(): VirtualZone {
    this.ensureEnabled();
    const zone = this.store.zone(this.zoneId) ?? this.store.zoneByName(this.domainName);
    if (!zone) throw new Error(`虚拟站点不存在: ${this.zoneId || this.domainName || '(未指定)'}`);
    this.zoneId = zone.ZoneId;
    return zone;
  }

  /** 源站组裸原语：与腾讯云提供商同一套客户端实现 */
  originGroups(): OriginGroupClient {
    this.ensureEnabled();
    const zoneId = this.zoneId || this.store.zoneByName(this.domainName)?.ZoneId || '';
    return new OriginGroupClient(createVirtualTeoCall(this.store), zoneId);
  }

  private toRecord(zone: VirtualZone, record: VirtualDnsRecord): DnsRecord {
    return {
      RecordId: record.RecordId,
      Domain: zone.ZoneName,
      Name: record.Name,
      Type: record.Type,
      Value: record.Value,
      Line: record.Line,
      TTL: record.TTL,
      MX: record.MX,
      Status: record.Status,
      Weight: record.Weight,
      Remark: record.Remark,
    };
  }

  async check(): Promise<boolean> {
    try {
      this.ensureEnabled();
      return this.store.data.zones.length >= 0;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  getError(): string {
    return this.lastError;
  }

  async getDomainList(keyword?: string, page = 1, pageSize = 20): Promise<PageResult<DomainInfo>> {
    this.ensureEnabled();
    const filter = String(keyword ?? '').trim().toLowerCase();
    const all = this.store.data.zones
      .filter((zone) => !filter || zone.ZoneName.toLowerCase().includes(filter))
      .map<DomainInfo>((zone) => ({
        Domain: zone.ZoneName,
        ThirdId: zone.ZoneId,
        RecordCount: zone.Records.length,
      }));
    const start = Math.max(page - 1, 0) * pageSize;
    return { total: all.length, list: all.slice(start, start + pageSize) };
  }

  async getDomainRecords(
    page = 1,
    pageSize = 100,
    keyword?: string,
    subdomain?: string,
    value?: string,
    type?: string,
    line?: string,
    status?: number,
  ): Promise<PageResult<DnsRecord>> {
    const zone = this.zone();
    const kw = String(keyword ?? '').trim().toLowerCase();
    const sub = String(subdomain ?? '').trim().toLowerCase();
    const val = String(value ?? '').trim().toLowerCase();
    const filtered = zone.Records.filter((record) => {
      if (kw && !`${record.Name} ${record.Value}`.toLowerCase().includes(kw)) return false;
      if (sub && record.Name.toLowerCase() !== sub) return false;
      if (val && record.Value.toLowerCase() !== val) return false;
      if (type && record.Type.toUpperCase() !== type.toUpperCase()) return false;
      if (line && record.Line !== line) return false;
      if (status !== undefined && record.Status !== status) return false;
      return true;
    }).map((record) => this.toRecord(zone, record));
    const start = Math.max(page - 1, 0) * pageSize;
    return { total: filtered.length, list: filtered.slice(start, start + pageSize) };
  }

  async getDomainRecordInfo(recordId: string): Promise<DnsRecord | null> {
    const zone = this.zone();
    const found = zone.Records.find((record) => record.RecordId === recordId);
    return found ? this.toRecord(zone, found) : null;
  }

  async addDomainRecord(
    name: string,
    type: string,
    value: string,
    line = 'default',
    ttl = DEFAULT_TTL,
    mx = 0,
    weight?: number,
    remark?: string,
  ): Promise<string | null> {
    const zone = this.zone();
    const recordId = 'vr-' + (zone.Records.length + 1) + '-' + Date.now().toString(36);
    zone.Records.push({
      RecordId: recordId,
      Name: String(name),
      Type: String(type).toUpperCase(),
      Value: String(value),
      TTL: Number(ttl) > 0 ? Number(ttl) : DEFAULT_TTL,
      Line: line || 'default',
      MX: Number(mx) || 0,
      Status: 1,
      Weight: weight,
      Remark: remark,
    });
    this.store.save();
    return recordId;
  }

  async updateDomainRecord(
    recordId: string,
    name: string,
    type: string,
    value: string,
    line?: string,
    ttl?: number,
    mx?: number,
    weight?: number,
    remark?: string,
  ): Promise<boolean> {
    const zone = this.zone();
    const target = zone.Records.find((record) => record.RecordId === recordId);
    if (!target) {
      this.lastError = `记录不存在: ${recordId}`;
      return false;
    }
    target.Name = String(name);
    target.Type = String(type).toUpperCase();
    target.Value = String(value);
    if (line) target.Line = line;
    if (ttl && ttl > 0) target.TTL = ttl;
    if (mx !== undefined) target.MX = Number(mx) || 0;
    if (weight !== undefined) target.Weight = weight;
    if (remark !== undefined) target.Remark = remark;
    this.store.save();
    return true;
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    const zone = this.zone();
    const index = zone.Records.findIndex((record) => record.RecordId === recordId);
    if (index < 0) {
      this.lastError = `记录不存在: ${recordId}`;
      return false;
    }
    zone.Records.splice(index, 1);
    this.store.save();
    return true;
  }

  async setDomainRecordStatus(recordId: string, status: number): Promise<boolean> {
    const zone = this.zone();
    const target = zone.Records.find((record) => record.RecordId === recordId);
    if (!target) {
      this.lastError = `记录不存在: ${recordId}`;
      return false;
    }
    target.Status = status ? 1 : 0;
    this.store.save();
    return true;
  }

  async getRecordLines(): Promise<Array<{ id: string; name?: string }>> {
    return [{ id: 'default', name: '默认' }];
  }

  async getMinTTL(): Promise<number> {
    return MIN_TTL;
  }

  async addDomain(domain: string): Promise<boolean> {
    this.ensureEnabled();
    const name = String(domain ?? '').trim();
    if (!name) {
      this.lastError = '域名不能为空';
      return false;
    }
    this.store.addZone(name);
    return true;
  }
}
