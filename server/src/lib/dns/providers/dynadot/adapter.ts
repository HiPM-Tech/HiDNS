import { BaseAdapter, Dict, DnsRecord, DomainInfo, PageResult, createProviderAdapterLogger, fetchWithFallback, isTruthyFlag, safeString, toNumber } from '../internal';
import { DynadotAuthConfig, dynadotRequest, resolveDynadotConfig } from './auth';
import { withDomainLock } from '../domain-lock';

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
      // 实测（2026-11-17，对照官方文档 §Set DNS2 参数表）：
      //   文档声称 main_record_type0-19 / main_record0-19 是根记录参数，
      //   且 add_dns_to_current_setting=1 表示「追加」而非覆盖。
      //   实测结果：
      //     main_record* + 覆盖模式                        -> 参数被忽略，zone 被清空
      //     main_record* + add_dns_to_current_setting=1    -> 返回 success，记录未写入（txt / 带引号 txt / a 均如此）
      //     subdomain 为空串                               -> 记录被丢弃
      //     subdomain 为 @                                 -> 上游校验拒绝（Subhost 格式错误）
      // 结论：api3 的 set_dns2 实际上写不了根记录（文档与实现不一致），因此禁用根记录写入。
      //
      // v2 写路径探测（2026-11-17）：
      //   POST / DELETE /restful/v2/domains/{d}/records 路径本身被识别
      //   （DELETE 返回 main_record_removed_count / sub_record_removed_count，不是 command not recognized），
      //   但记录 body 试了 10+ 种结构全部返回 Please enter at least one DNS record：
      //     dns_sub_list / dns_records / records / 裸数组 / 追加 dns_main_list /
      //     api3 字段名(subdomain+sub_record_type+sub_record) / 通用字段名(host+type+value) /
      //     大写 record_type / 有无连字符的 sub_host
      //   结论：v2 的写结构无法从公开文档或试错确定 → 写操作固定走 api3 的 set_dns2。
      if (!name || name === '@') {
        this.error = 'Dynadot 暂不支持写入根记录（实测会导致 zone 被清空，尚未确认参数语义）';
        return null;
      }
      // set_dns2 是全量保存：同域名的写操作必须串行，否则并发时会互相覆盖
      return await withDomainLock(String(this.config.domain), async () => {
        const { records: current, ttl: zoneTtl } = await this.fetchAllRawRecords();
        current.push({ name, type, value, mx });
        await this.saveAllRecords(current, zoneTtl);
        return this.buildRecordId(name, type, value, mx);
      });
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
      if (!target.name || target.name === '@' || !name || name === '@') {
        this.error = 'Dynadot 暂不支持修改根记录（实测会导致 zone 被清空，尚未确认参数语义）';
        return false;
      }
      return await withDomainLock(String(this.config.domain), async () => {
        const { records: current, ttl: zoneTtl } = await this.fetchAllRawRecords();
        const idx = current.findIndex((row) => this.matchesRow(row, target));
        if (idx === -1) {
          this.error = '未找到要更新的记录（可能已被外部修改）';
          return false;
        }
        current[idx] = { name, type, value, mx };
        await this.saveAllRecords(current, zoneTtl);
        return true;
      });
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    try {
      if (!this.config.domain) return false;
      const target = this.parseRecordId(recordId);
      if (!target.name || target.name === '@') {
        this.error = 'Dynadot 暂不支持删除根记录（实测会导致 zone 被清空，尚未确认参数语义）';
        return false;
      }
      return await withDomainLock(String(this.config.domain), async () => {
        const { records: current, ttl: zoneTtl } = await this.fetchAllRawRecords();
        const idx = current.findIndex((row) => this.matchesRow(row, target));
        if (idx === -1) {
          this.error = '未找到要删除的记录（可能已被外部删除）';
          return false;
        }
        // 只删第一条匹配：同名同类型的重复记录不应被一次全删
        current.splice(idx, 1);
        await this.saveAllRecords(current, zoneTtl);
        return true;
      });
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


  /**
   * 读取全部记录（写路径专用）。
   *
   * 与 getDomainRecords 的区别（审核 P0）：
   * - 不复用会吞异常、会按 pageSize 截断的列表接口；
   * - 请求失败 / 结构异常 / 域名未托管在 Dynadot → 一律抛错，绝不返回空数组冒充「没有记录」；
   * - 否则一次网络抖动就会让 add 把整域写回成 1 条。
   */
  private async fetchAllRawRecords(): Promise<{ records: Array<{ name: string; type: string; value: string; mx?: number }>; ttl?: number }> {
    if (!this.config.domain) throw new Error('未解析到域名');
    const holder = await dynadotRequest<unknown>(this.config, 'GET', PATHS.records(this.config.domain));
    const data = ((holder ?? {}) as Record<string, unknown>).data as Record<string, unknown> | undefined;
    const glue = data?.glue_info as Record<string, unknown> | undefined;
    const glueType = safeString(glue?.glue_type);
    if (glueType && glueType !== 'DNS') {
      throw new Error('该域名的 NS 未指向 Dynadot，无法写回解析记录');
    }
    const list = glue?.dns_sub_list;
    if (!Array.isArray(list)) {
      throw new Error('Dynadot 返回结构异常（dns_sub_list 不是数组），已中止写入以免覆盖现有记录');
    }
    const glueTtl = toNumber(glue?.ttl, Number.NaN);
    const records = list.map((row) => {
      const rowObj = row as Dict;
      const type = safeString(rowObj.record_type).toUpperCase();
      return {
        name: safeString(rowObj.sub_host) || '@',
        type,
        value: safeString(rowObj.record_value1),
        // 响应里没有独立的优先级字段：MX 的优先级无法读回时保持 undefined，由 saveAllRecords 拒绝写入
        mx: type === 'MX' ? toNumber(rowObj.priority ?? rowObj.mx ?? Number.NaN, Number.NaN) : undefined,
      };
    });
    return { records, ttl: Number.isFinite(glueTtl) ? glueTtl : undefined };
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
  private async saveAllRecords(
    records: Array<{ name: string; type: string; value: string; mx?: number }>,
    zoneTtl?: number,
  ): Promise<void> {
    if (!this.config.domain) throw new Error('未解析到域名');
    if (records.length === 0) {
      throw new Error('Dynadot 的 set_dns2 至少需要保留一条记录，无法删除最后一条');
    }
    // MX 优先级读不回来时拒绝写回：否则会把优先级清零，直接影响收信
    const mxWithoutPriority = records.find(
      (row) => row.type.toUpperCase() === 'MX' && !(typeof row.mx === 'number' && Number.isFinite(row.mx)),
    );
    if (mxWithoutPriority) {
      throw new Error(`检测到 MX 记录（${mxWithoutPriority.name}）但读不到优先级，已中止写入以免清零`);
    }

    const rootRecord = records.find((row) => !row.name || row.name === '@');
    if (rootRecord) {
      throw new Error('Dynadot 暂不支持写回含根记录的 zone（实测会导致 zone 被清空，尚未确认参数语义）');
    }

    const params = buildSetDns2Params(this.config.apiKey, this.config.domain, records, zoneTtl);
    await this.setDns2Request(params);
  }

  /** 发送 api3 的 set_dns2；抽成独立方法，便于测试替换与单点维护 */
  private async setDns2Request(params: URLSearchParams): Promise<void> {
    const url = `https://api.dynadot.com/api3.json?${params.toString()}`;
    const res = await fetchWithFallback(url, { method: 'GET', headers: { Accept: 'application/json' } }, isTruthyFlag(this.config.useProxy), 'Dynadot');
    const text = await res.text();
    let payload: { SetDnsResponse?: { ResponseCode?: number; Status?: string; Error?: string } } | null = null;
    try { payload = JSON.parse(text); } catch { payload = null; }
    const body = payload?.SetDnsResponse;
    if (!res.ok || body?.ResponseCode !== 0 || safeString(body?.Error)) {
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
  ttl?: number,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set('key', apiKey);
  params.set('command', 'set_dns2');
  params.set('domain', domain);
  if (typeof ttl === 'number' && Number.isFinite(ttl)) params.set('ttl', String(ttl));
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
