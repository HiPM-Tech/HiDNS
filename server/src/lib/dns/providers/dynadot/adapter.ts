import { BaseAdapter, Dict, DnsRecord, DomainInfo, PageResult, createProviderAdapterLogger, fetchWithFallback, isTruthyFlag, safeString, toNumber } from '../internal';
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
      // v2 的写路径无法从文档确定（POST/DELETE /records 各种 body 均被拒），
      // 改用官方 api3 的 set_dns2（全量设置）：读现有 → 追加 → 全量写回。
      const current = await this.readRawRecords();
      current.push({ name, type, value, mx });
      await this.saveAllRecords(current);
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
      const current = await this.readRawRecords();
      const idx = current.findIndex((row) => this.matchesRow(row, target));
      if (idx === -1) {
        this.error = '未找到要更新的记录（可能已被外部修改）';
        return false;
      }
      current[idx] = { name, type, value, mx };
      await this.saveAllRecords(current);
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
      const current = await this.readRawRecords();
      const remaining = current.filter((row) => !this.matchesRow(row, target));
      if (remaining.length === current.length) {
        this.error = '未找到要删除的记录（可能已被外部删除）';
        return false;
      }
      await this.saveAllRecords(remaining);
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


  /** 读取全部记录（原始形态），供写操作「读-改-写」使用 */
  private async readRawRecords(): Promise<Array<{ name: string; type: string; value: string; mx?: number }>> {
    const page = await this.getDomainRecords();
    return page.list.map((record) => ({
      name: record.Name,
      type: record.Type,
      value: record.Value,
      mx: record.MX,
    }));
  }

  private matchesRow(
    row: { name: string; type: string; value: string },
    target: { name: string; type: string; value: string },
  ): boolean {
    return row.type.toUpperCase() === target.type.toUpperCase()
      && row.name.toLowerCase() === target.name.toLowerCase()
      && row.value === target.value;
  }

  /**
   * 全量写回。v2 的 POST/DELETE /records 在文档里没有给出可用结构（实测各种 body 均被拒），
   * 改用官方 api3 的 set_dns2：根记录用 main_record*，子记录用 subdomain* / sub_record*。
   */
  private async saveAllRecords(records: Array<{ name: string; type: string; value: string; mx?: number }>): Promise<void> {
    if (!this.config.domain) throw new Error('未解析到域名');
    if (records.length === 0) {
      this.error = 'Dynadot 的 set_dns2 至少需要保留一条记录，无法删除最后一条';
      throw new Error(this.error);
    }

    const params = buildSetDns2Params(this.config.apiKey, this.config.domain, records);

    const url = `https://api.dynadot.com/api3.json?${params.toString()}`;
    const res = await fetchWithFallback(url, { method: 'GET', headers: { Accept: 'application/json' } }, isTruthyFlag(this.config.useProxy), 'Dynadot');
    const text = await res.text();
    let payload: { SetDnsResponse?: { ResponseCode?: number; Status?: string; Error?: string } } | null = null;
    try { payload = JSON.parse(text); } catch { payload = null; }
    const body = payload?.SetDnsResponse;
    if (!res.ok || body?.ResponseCode !== 0) {
      const detail = body?.Error || body?.Status || text.slice(0, 160) || `HTTP ${res.status}`;
      throw new Error(`Dynadot set_dns2 失败：${detail}`);
    }
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

/**
 * 构造 api3 的 set_dns2 查询参数（全量设置）。
 * 根记录用 main_record*，子记录用 subdomain* / sub_record*；MX 的优先级放在 main_recordx*。
 */
export function buildSetDns2Params(
  apiKey: string,
  domain: string,
  records: Array<{ name: string; type: string; value: string; mx?: number }>,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set('key', apiKey);
  params.set('command', 'set_dns2');
  params.set('domain', domain);
  let mainIndex = 0;
  let subIndex = 0;
  for (const record of records) {
    const type = record.type.toLowerCase();
    const isRoot = !record.name || record.name === '@';
    if (isRoot) {
      params.set(`main_record_type${mainIndex}`, type);
      params.set(`main_record${mainIndex}`, record.value);
      if (type === 'mx' && typeof record.mx === 'number') params.set(`main_recordx${mainIndex}`, String(record.mx));
      mainIndex += 1;
    } else {
      params.set(`subdomain${subIndex}`, record.name);
      params.set(`sub_record_type${subIndex}`, type);
      params.set(`sub_record${subIndex}`, record.value);
      subIndex += 1;
    }
  }
  return params;
}
