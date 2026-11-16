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
  // 实测：记录端点是 /records（/dns 与 /dns_records 都返回 command not recognized）
  records: (domain: string) => `/domains/${encodeURIComponent(domain)}/records`,
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
      // 不能用 getDomainList() 判断凭据：它把异常吞成空列表，坏凭据也会返回 true。
      // 这里直接发一次请求，失败就上抛。
      await dynadotRequest(this.config, 'GET', PATHS.domains);
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async getDomainList(keyword?: string, page = 1, pageSize = 100): Promise<PageResult<DomainInfo>> {
    try {
      const data = await dynadotRequest<unknown>(this.config, 'GET', PATHS.domains);
      // 实测结构：{ code:200, data:{ domain_info_list: [{ domain_name, expiration_date, glue_info }] } }
      const holder = (data ?? {}) as Record<string, unknown>;
      const dataObj = (holder.data ?? {}) as Record<string, unknown>;
      const rows = this.pickArray(dataObj.domain_info_list ?? holder.data, ['domain_info_list', 'domains', 'items', 'list']);
      let list = rows.map((row) => {
        const name = safeString(row.domain_name) || safeString(row.domain) || safeString(row.domainName) || safeString(row.name);
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
      const data = await dynadotRequest<unknown>(this.config, 'GET', PATHS.records(this.config.domain));
      // 实测结构：{ data:{ glue_info:{ glue_type:'DNS', dns_sub_list:[{sub_host,record_type,record_value1}], ttl:'300' } } }
      const holder = (data ?? {}) as Record<string, unknown>;
      const glue = ((holder.data ?? {}) as Record<string, unknown>).glue_info as Record<string, unknown> | undefined;
      if (glue && safeString(glue.glue_type) && safeString(glue.glue_type) !== 'DNS') {
        // 该域名没托管在 Dynadot 的 DNS 上（例如 NS 指向 Cloudflare），没有可管理的记录。
        // 空结果必须写 error 说明原因（全局契约：空列表不能静默）。
        this.error = '该域名的 NS 未指向 Dynadot（无法在此管理解析记录）';
        return { total: 0, list: [] };
      }
      const ttl = toNumber(glue?.ttl, 600);
      const rows = this.pickArray(glue?.dns_sub_list ?? holder.data, ['dns_sub_list', 'records', 'items', 'list']);
      let list = rows.map((row) => this.mapRecord(row, ttl));
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
      // 实测：POST /records 需要 { dns_sub_list: [...] }，字段为 sub_host / record_type / record_value1
      const payload = { dns_sub_list: [this.toPayload(name, type, value, mx)], ttl: String(ttl) };
      await dynadotRequest(this.config, 'POST', PATHS.records(this.config.domain), { body: payload });
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
      // 实测：v2 没有 PUT（返回 command not recognized），修改 = 删除旧记录 + 新增新记录
      await dynadotRequest(this.config, 'DELETE', PATHS.records(this.config.domain), {
        body: { dns_sub_list: [this.toPayload(target.name, target.type, target.value, target.mx)] },
      });
      await dynadotRequest(this.config, 'POST', PATHS.records(this.config.domain), {
        body: { dns_sub_list: [this.toPayload(name, type, value, mx)], ttl: String(ttl) },
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
      const target = this.parseRecordId(recordId);
      await dynadotRequest(this.config, 'DELETE', PATHS.records(this.config.domain), {
        body: { dns_sub_list: [this.toPayload(target.name, target.type, target.value, target.mx)] },
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

  /** 实测字段：sub_host / record_type（小写）/ record_value1 */
  private toPayload(name: string, type: string, value: string, _mx?: number): Dict {
    return {
      sub_host: name || '@',
      record_type: type.toLowerCase(),
      record_value1: value,
    };
  }

  private mapRecord(row: Dict, glueTtl = 600): DnsRecord {
    // 实测字段：{ sub_host, record_type, record_value1 }，TTL 在 glue_info 层级
    const type = safeString(row.record_type || row.type || row.recordType).toUpperCase();
    const value = safeString(row.record_value1)
      || safeString(row.value)
      || safeString(row.content)
      || safeString(row.address)
      || safeString(row.data);
    const name = safeString(row.sub_host) || safeString(row.name) || safeString(row.host) || '@';
    const mx = toNumber(row.priority ?? row.mx, 0);
    return {
      RecordId: this.buildRecordId(name, type, value, mx),
      Domain: this.config.domain || '',
      Name: name || '@',
      Type: type,
      Value: value,
      Line: DEFAULT_LINE,
      TTL: toNumber(row.ttl ?? glueTtl, 600),
      MX: mx,
      Status: 1,
      Weight: undefined,
      Remark: undefined,
      UpdateTime: undefined,
    };
  }
}