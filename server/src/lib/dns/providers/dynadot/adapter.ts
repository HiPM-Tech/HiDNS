import { BaseAdapter, Dict, DnsRecord, DomainInfo, PageResult, createProviderAdapterLogger, fetchWithFallback, isTruthyFlag, parseOptionalNumber, safeString, toNumber } from '../internal';
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
      // 根记录在 dns_main_list（无 sub_host），子记录在 dns_sub_list
      const mainRows = this.pickArray(glue?.dns_main_list, ['dns_main_list']);
      const subRows = this.pickArray(glue?.dns_sub_list ?? holder.data, ['dns_sub_list', 'records', 'items', 'list']);
      const rows = [...mainRows, ...subRows];
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

  async getDomainRecordInfo(recordId: string): Promise<DnsRecord | null> {
    try {
      if (!this.config.domain) return null;
      const target = this.parseRecordId(recordId);
      const { records } = await this.fetchAllRawRecords();
      const row = records.find((item) => this.matchesRow(item, target));
      if (!row) return null;
      return {
        RecordId: this.buildRecordId(row.name, row.type, row.value, row.mx ?? 0),
        Domain: this.config.domain,
        Name: row.name || '@',
        Type: row.type,
        Value: row.value,
        Line: DEFAULT_LINE,
        TTL: 600,
        MX: row.mx ?? 0,
        Status: 1,
        Weight: undefined,
        Remark: undefined,
        UpdateTime: undefined,
      };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return null;
    }
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
      // 根记录写入（2026-11-21 实测通过）：
      //   main_record_type0 + main_record0 是正确参数，但必须满足：
      //     1) 覆盖模式（add_dns_to_current_setting=1 对 main 无效）
      //     2) 与全部 subdomain* 一起提交（覆盖语义）
      //     3) TXT 值带引号，否则该记录被判无效并丢弃
      //   读回：v2 GET 的 data.glue_info.dns_main_list 就是根记录（无 sub_host）。
      //
      // v2 写路径探测（2026-11-17）：POST/DELETE /records 路径被识别，但 body 结构
      // 试了 10+ 种全部返回 Please enter at least one DNS record → 写操作固定走 api3 set_dns2。
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
      return await withDomainLock(String(this.config.domain), async () => {
        const { records: current, ttl: zoneTtl } = await this.fetchAllRawRecords();
        const idx = current.findIndex((row) => this.matchesRow(row, target));
        if (idx === -1) {
          this.error = '未找到要更新的记录（可能已被外部修改）';
          return false;
        }
        // 服务层传的 mx 可能是 0/缺省；改 value 时不能把已有 MX 优先级清掉
        const nextMx = type.toUpperCase() === 'MX' && (!Number.isFinite(mx) || mx <= 0) ? target.mx : mx;
        current[idx] = { name, type, value, mx: nextMx };
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
    const mainList = glue?.dns_main_list;
    const subList = glue?.dns_sub_list;
    // 注意：dns_main_list 在「无根记录」时可能缺失，dns_sub_list 则总会返回。
    // 只要 sub 缺失就视为结构异常并中止——否则只剩根记录写回会把全部子记录清空。
    if (!Array.isArray(subList)) {
      throw new Error('Dynadot 返回结构异常（dns_sub_list 不是数组），已中止写入以免覆盖现有记录');
    }
    // 实测（2026-11-21）：v2 GET 与 api3 get_dns 对 dns_sub_list 都有 100 条硬上限，
    // 传 take/limit/page/pageSize 均无效。记录数达到上限时读不全，覆盖写回会丢掉剩余记录，因此拒绝写入。
    const readableLimit = 100;
    if (subList.length >= readableLimit) {
      throw new Error(
        `Dynadot 记录接口最多返回 ${readableLimit} 条（实测硬上限，无法分页），当前 zone 已达到上限，` +
        '无法安全执行全量写回（继续写会丢掉超出的记录）',
      );
    }

    // 根记录（dns_main_list）必须一起读出来：set_dns2 是覆盖语义，漏读根记录会在写回时把它清掉
    const list = [...(Array.isArray(mainList) ? mainList : []), ...(Array.isArray(subList) ? subList : [])];
    const glueTtl = toNumber(glue?.ttl, Number.NaN);
    const records = list.map((row) => {
      const rowObj = row as Dict;
      const type = safeString(rowObj.record_type).toUpperCase();
      return {
        name: safeString(rowObj.sub_host) || '@',
        type,
        value: safeString(rowObj.record_value1),
        // 优先级在 record_value2；空串/null 要当成「读不到」而不是 0（Number('') === 0）
        mx: type === 'MX' ? parseOptionalNumber(rowObj.record_value2 ?? rowObj.priority) : undefined,
      };
    });
    return { records, ttl: Number.isFinite(glueTtl) ? glueTtl : undefined };
  }

  private matchesRow(
    row: { name: string; type: string; value: string; mx?: number },
    target: { name: string; type: string; value: string; mx?: number },
  ): boolean {
    return row.type.toUpperCase() === target.type.toUpperCase()
      && row.name.toLowerCase() === target.name.toLowerCase()
      && row.value === target.value
      // 同名同值的 MX 可能有不同优先级，必须一并比较，否则会误删/误改另一条
      && (row.mx ?? 0) === (target.mx ?? 0);
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


    // MX 优先级读不到时拒绝写回：覆盖语义下会把它清零，直接影响收信
    const mxWithoutPriority = records.find(
      (row) => row.type.toUpperCase() === 'MX' && !(typeof row.mx === 'number' && Number.isFinite(row.mx) && row.mx > 0),
    );
    if (mxWithoutPriority) {
      throw new Error(`检测到 MX 记录（${mxWithoutPriority.name}）但读不到有效优先级，已中止写入以免清零`);
    }

    // 写前校验：覆盖语义下，任何一条无效记录都会让上游丢弃它（甚至整批），宁可直接失败
    const allowedTypes = new Set(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'NS']);
    for (const row of records) {
      const type = row.type.toUpperCase();
      if (!allowedTypes.has(type)) throw new Error(`Dynadot 不支持写入记录类型 ${row.type}`);
      if (!row.value) throw new Error(`记录 ${row.name || '@'} ${type} 的值为空，已中止写入以免丢记录`);
    }

    const params = buildSetDns2Params(this.config.apiKey, this.config.domain, records, zoneTtl);
    await this.setDns2Request(params);

    // 写后回读校验：set_dns2 存在「返回 success 但没写入」的分支（实测见上），只看 ResponseCode 不够
    const { records: after } = await this.fetchAllRawRecords();
    const norm = (row: { name: string; type: string; value: string; mx?: number }) =>
      `${(row.name || '@').toLowerCase()}|${row.type.toUpperCase()}|${row.type.toUpperCase() === 'TXT' ? row.value.replace(/^"|"$/g, '') : row.value}|${row.type.toUpperCase() === 'MX' ? (row.mx ?? 0) : 0}`;
    const expected = new Set(records.map(norm));
    const actual = new Set(after.map(norm));
    if (expected.size !== actual.size || [...expected].some((key) => !actual.has(key))) {
      throw new Error(`写入后校验失败：预期 ${expected.size} 条，实际 ${actual.size} 条（zone 可能已被部分修改）`);
    }
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
    // 根记录读回一律是 @（不是空串），TXT 读回带引号 —— ID 必须与读回形态一致，否则删/改匹配不上
    const normalizedName = name || '@';
    const upperType = type.toUpperCase();
    const normalizedValue = upperType === 'TXT' && !/^".*"$/.test(value) ? `"${value}"` : value;
    const normalizedMx = upperType === 'MX' ? mx : 0;
    return `${upperType}|${normalizedName}|${normalizedValue}|${normalizedMx}`;
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
    // 实测：MX 优先级在 record_value2（v2） / Value2（api3）里
    const mx = toNumber(row.record_value2 ?? row.priority ?? row.mx, 0);
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
    // 实测：SRV/CAA 的值是单字段完整串（SRV: "priority weight port target"；CAA: "flags tag value"），
    // 上游不拆字段、读回 record_value1 即完整值，因此不需要 sub_recordx。
    // 实测：TXT 值必须带引号，否则上游判定该记录无效并丢弃（覆盖模式下等于丢记录）
    const quoted = /^".*"$/.test(record.value);
    if (type === 'txt' && !quoted && record.value.includes('"')) {
      // 内部引号不转义会拼出畸形串（如 SPF 里的 "_spf.example.com"），宁可直接失败
      throw new Error(`TXT 记录（${record.name || '@'}）的值包含未转义的引号，无法安全写回`);
    }
    const value = type === 'txt' && !quoted ? `"${record.value}"` : record.value;
    const isRoot = !record.name || record.name === '@';
    if (isRoot) {
      params.set(`main_record_type${mainIndex}`, type);
      params.set(`main_record${mainIndex}`, value);
      if (type === 'mx' && typeof record.mx === 'number' && Number.isFinite(record.mx)) {
        params.set(`main_recordx${mainIndex}`, String(record.mx));
      }
      mainIndex += 1;
    } else {
      params.set(`subdomain${subIndex}`, record.name);
      params.set(`sub_record_type${subIndex}`, type);
      params.set(`sub_record${subIndex}`, value);
      if (type === 'mx' && typeof record.mx === 'number' && Number.isFinite(record.mx)) {
        params.set(`sub_recordx${subIndex}`, String(record.mx));
      }
      subIndex += 1;
    }
  }
  return params;
}
