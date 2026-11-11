import { BaseAdapter, Dict, DnsRecord, DomainInfo, PageResult, createProviderAdapterLogger, safeString, toNumber } from '../internal';
import { DynadotAuthConfig, dynadotRequest, resolveDynadotConfig } from './auth';

const log = createProviderAdapterLogger('Dynadot');
export const DEFAULT_LINE = '0';

/**
 * v2 资源路径（文档模板：/restful/v2/{resource}/{resource_identify}/{action}）。
 * DNS 记录按 Dynadot 的 get_dns / set_dns2 命令语义映射为「域名下的 dns 资源」；
 * 若上游返回 404，只需改这里的两条常量即可（不做散落硬编码）。
 */
const PATHS = {
  domains: '/domains',
  dns: (domain: string) => `/domains/${encodeURIComponent(domain)}/dns`,
};

interface DynadotConfig extends DynadotAuthConfig {
  domain?: string;
}

export class DynadotAdapter extends BaseAdapter {
  private config: DynadotConfig;

  constructor(rawConfig: Record<string, string>) {
    super();
    this.config = { ...resolveDynadotConfig(rawConfig), domain: safeString(rawConfig.domain) };
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
      const data = await dynadotRequest<unknown>(this.config, 'GET', PATHS.domains, { signed: false });
      const rows = this.pickArray(data, ['domains', 'data', 'items', 'list']);
      let list = rows.map((row) => {
        const name = safeString(row.domain) || safeString(row.domainName) || safeString(row.name);
        return { Domain: name, ThirdId: name, RecordCount: 0 };
      }).filter((item) => item.Domain);

      if (keyword) {
        const kw = keyword.toLowerCase();
        list = list.filter((item) => item.Domain.toLowerCase().includes(kw));
      }

      const start = (page - 1) * pageSize;
      return { total: list.length, list: list.slice(start, start + pageSize) };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      log.sub('API').tag('ERROR').error('getDomainList failed', { error: this.error });
      return { total: 0, list: [] };
    }
  }

  async getDomainRecords(
    page = 1,
    pageSize = 100,
    _keyword?: string,
    subdomain?: string,
    _value?: string,
    _type?: string,
    _line?: string,
    _status?: number,
  ): Promise<PageResult<DnsRecord>> {
    try {
      if (!this.config.domain) {
        this.error = this.error || '读取记录失败：未解析到域名';
        return { total: 0, list: [] };
      }
      const data = await dynadotRequest<unknown>(this.config, 'GET', PATHS.dns(this.config.domain), { signed: false });
      const rows = this.pickArray(data, ['records', 'dns', 'data', 'items', 'list']);
      let list = rows.map((row) => this.mapRecord(row));
      if (subdomain) {
        const target = subdomain.toLowerCase();
        list = list.filter((item) => item.Name.toLowerCase() === target);
      }
      const start = (page - 1) * pageSize;
      return { total: list.length, list: list.slice(start, start + pageSize) };
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
    weight?: number,
    remark?: string,
  ): Promise<string | null> {
    try {
      if (!this.config.domain) return null;
      const payload = this.toPayload(name, type, value, mx, ttl, weight, remark);
      // 文档：批量不受支持，每种请求仅处理一个对象
      await dynadotRequest(this.config, 'POST', PATHS.dns(this.config.domain), { body: payload });
      return this.buildRecordId(name, type, value, mx);
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
    weight?: number,
    remark?: string,
  ): Promise<boolean> {
    try {
      if (!this.config.domain) return false;
      const target = this.parseRecordId(recordId);
      const payload = {
        ...this.toPayload(name, type, value, mx, ttl, weight, remark),
        // 用于定位原记录（改名/改值都要先匹配旧行）
        original: this.toPayload(target.name, target.type, target.value, target.mx),
      };
      await dynadotRequest(this.config, 'PUT', PATHS.dns(this.config.domain), { body: payload });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    try {
      if (!this.config.domain) return false;
      const target = this.parseRecordId(recordId);
      await dynadotRequest(this.config, 'DELETE', PATHS.dns(this.config.domain), {
        body: this.toPayload(target.name, target.type, target.value, target.mx),
      });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async setDomainRecordStatus(_recordId: string, _status: number): Promise<boolean> {
    this.error = 'Dynadot 不支持记录级启停';
    return false;
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    return [{ id: DEFAULT_LINE, name: '默认' }];
  }

  async getMinTTL(): Promise<number> {
    return 60;
  }

  async addDomain(_domain: string): Promise<boolean> {
    this.error = 'Dynadot 不支持通过 API 直接添加域名';
    return false;
  }

  private pickArray(data: unknown, keys: string[]): Dict[] {
    if (Array.isArray(data)) return data as Dict[];
    if (data && typeof data === 'object') {
      const holder = data as Record<string, unknown>;
      for (const key of keys) {
        if (Array.isArray(holder[key])) return holder[key] as Dict[];
      }
    }
    return [];
  }

  private buildRecordId(name: string, type: string, value: string, mx: number): string {
    return `${type}|${name}|${value}|${mx}`;
  }

  private parseRecordId(recordId: string): { type: string; name: string; value: string; mx: number } {
    const parts = recordId.split('|');
    return {
      type: parts[0] ?? '',
      name: parts[1] ?? '',
      value: parts[2] ?? '',
      mx: toNumber(parts[3] || '0', 0),
    };
  }

  private toPayload(
    name: string,
    type: string,
    value: string,
    mx: number,
    ttl = 600,
    weight?: number,
    remark?: string,
  ): Dict {
    const payload: Dict = {
      name: name === '@' ? '' : name,
      type: type.toUpperCase(),
      value,
      ttl: toNumber(ttl, 600),
    };
    if (payload.type === 'MX') payload.priority = mx;
    if (weight !== undefined) payload.weight = weight;
    if (remark) payload.remark = remark;
    return payload;
  }

  private mapRecord(row: Dict): DnsRecord {
    const type = safeString(row.type || row.recordType || row.record_type).toUpperCase();
    const value = safeString(row.value) || safeString(row.content) || safeString(row.address) || safeString(row.data);
    const name = safeString(row.name ?? row.host ?? '@');
    const mx = toNumber(row.priority ?? row.mx, 0);
    return {
      RecordId: this.buildRecordId(name, type, value, mx),
      Domain: this.config.domain || '',
      Name: name || '@',
      Type: type,
      Value: value,
      Line: DEFAULT_LINE,
      TTL: toNumber(row.ttl, 600),
      MX: mx,
      Status: 1,
      Weight: undefined,
      Remark: undefined,
      UpdateTime: undefined,
    };
  }
}