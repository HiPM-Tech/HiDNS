import { createProviderAdapterLogger, DnsAdapter, DnsRecord, DomainInfo, PageResult, BaseAdapter, Dict, safeString, toNumber, fetchWithFallback, isTruthyFlag } from '../internal';
export const DEFAULT_LINE = '0';

/**
 * 按域名串行化写操作。
 *
 * Spaceship 的 PUT 是「全量保存」：read → modify → write 之间若插入另一个写，
 * 后写完的会把先写完的覆盖掉（典型的 lost update）。
 * 单实例内用队列串行即可；多实例部署需要分布式锁，超出当前范围。
 */
const domainWriteQueues = new Map<string, Promise<unknown>>();

export function withDomainLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const k = (key || '__default__').toLowerCase();
  const prev = domainWriteQueues.get(k) ?? Promise.resolve();
  // 前一个任务无论成功失败都要继续执行下一个
  const run = prev.then(() => fn(), () => fn());
  const tail = run.then(() => undefined, () => undefined);
  domainWriteQueues.set(k, tail);
  void tail.finally(() => {
    // 只有自己还是队尾时才清理，避免把后来者的链丢掉
    if (domainWriteQueues.get(k) === tail) domainWriteQueues.delete(k);
  });
  return run;
}

const log = createProviderAdapterLogger('Spaceship');
interface SpaceshipConfig {
  apiKey: string;
  apiSecret: string;
  domain?: string;
  useProxy?: boolean;
}

export class SpaceshipAdapter extends BaseAdapter {
  private config: SpaceshipConfig;
  private baseUrl = 'https://spaceship.dev/api/v1';

  constructor(config: Record<string, string>) {
    super();
    this.config = {
      // UI uses `apiKey`/`apiSecret`; keep legacy `apikey`/`apisecret` for backward compatibility.
      apiKey: safeString(config.apiKey) || safeString(config.apikey),
      apiSecret: safeString(config.apiSecret) || safeString(config.apisecret),
      domain: safeString(config.domain),
      useProxy: isTruthyFlag(config.useProxy),
    };
  }

  private getHeaders(): Record<string, string> {
    return {
      'X-API-Key': this.config.apiKey,
      'X-API-Secret': this.config.apiSecret,
    };
  }

  private async request<T>(method: string, path: string, params?: Dict): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    let body: string | undefined;
    const headers = this.getHeaders();

    if (method === 'GET') {
      if (params) {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
          query.set(key, String(value));
        }
        url += '?' + query.toString();
      }
    } else {
      body = JSON.stringify(params);
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetchWithFallback(url, { method, headers, body }, this.config.useProxy, 'Spaceship');
    const data = (await res.json()) as Dict;

    if (res.status !== 200 && res.status !== 204) {
      throw new Error(safeString(data.detail) || `Spaceship request failed: ${res.status}`);
    }

    return (res.status === 204 ? undefined : data) as T;
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
      const data = await this.request<{ items: Array<{ name: string }>; total: number }>('GET', '/domains', { take: pageSize, skip: (page - 1) * pageSize });
      let list = (data.items || []).map((row) => ({
        Domain: row.name,
        ThirdId: row.name,
        RecordCount: 0,
      }));
      if (keyword) {
        list = list.filter((d) => d.Domain.toLowerCase().includes(keyword.toLowerCase()));
      }
      return { total: data.total || list.length, list };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      log.error('getDomainList failed', this.error);
      return { total: 0, list: [] };
    }
  }

  async getDomainRecords(
    page = 1,
    pageSize = 20,
    _keyword?: string,
    subdomain?: string,
    _value?: string,
    _type?: string,
    _line?: string,
    _status?: number
  ): Promise<PageResult<DnsRecord>> {
    try {
      if (!this.config.domain) {
        this.error = this.error || '读取记录失败：未解析到域名或上游返回空结果';
        return { total: 0, list: [] };
      }

      const params: Dict = { take: pageSize, skip: (page - 1) * pageSize };
      if (subdomain) {
        params.take = 100;
        params.skip = 0;
      }

      const data = await this.request<{ items: Array<Dict>; total: number }>('GET', `/dns/records/${this.config.domain}`, params);
      let list = (data.items || []).map((row) => this.mapRecord(row));

      if (subdomain) {
        list = list.filter((r) => r.Name.toLowerCase() === subdomain.toLowerCase());
      }

      return { total: data.total || list.length, list };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return { total: 0, list: [] };
    }
  }

  async getDomainRecordInfo(_recordId: string): Promise<DnsRecord | null> {
    return null;
  }

  /**
   * 拉取该域名的**全部**原始记录（Spaceship 的 PUT 是「全量保存」，必须先读后写）。
   * 单页上限 500，按 total 循环直到取完。
   */
  private async fetchAllRawRecords(): Promise<Dict[]> {
    const all: Dict[] = [];
    let skip = 0;
    const take = 500;
    for (let guard = 0; guard < 40; guard += 1) {
      const data = await this.request<{ items?: Dict[]; total?: number }>(
        'GET',
        `/dns/records/${this.config.domain}`,
        { take, skip },
      );
      // 读失败绝不能被当成「没有记录」：PUT 是全量保存，用空列表覆盖会清空该域名的全部解析。
      // 结构异常（items 不是数组）一律中止写入。
      const items = (data as { items?: unknown }).items;
      if (!Array.isArray(items)) {
        throw new Error('Spaceship 返回结构异常（items 不是数组），已中止写入以免覆盖现有记录');
      }
      all.push(...(items as Dict[]));
      const total = typeof data.total === 'number' ? data.total : all.length;
      if (items.length === 0 || all.length >= total) break;
      skip += take;
    }
    return all;
  }

  /**
   * 全量保存。官方文档：PUT /v1/dns/records/{domain} = Save resource records，
   * body 为 { force, items }，items 上限 500；DELETE 同路径表示「删除该域名的全部记录」。
   * 因此「增/改/删单条」都要先读全量、改完再整体保存，绝不能只 PUT 一条（那样会把其它记录清空）。
   */
  private async saveAllRawRecords(items: Dict[]): Promise<void> {
    if (items.length === 0) {
      await this.request('DELETE', `/dns/records/${this.config.domain}`);
      return;
    }
    if (items.length > 500) {
      throw new Error('Spaceship 单次保存上限为 500 条记录，当前域名记录过多');
    }
    await this.request('PUT', `/dns/records/${this.config.domain}`, { force: true, items });
  }

  /** recordId 形如 type|name|value|mx，用于在原始记录里定位目标行 */
  private parseRecordId(recordId: string): { type: string; name: string; value: string; mx: number } {
    const parts = recordId.split('|');
    return {
      type: parts[0] ?? '',
      name: parts[1] ?? '',
      value: parts[2] ?? '',
      mx: toNumber(parts[3] || '0', 0),
    };
  }

  private matchesRecord(row: Dict, target: { type: string; name: string; value: string }): boolean {
    const mapped = this.mapRecord(row);
    return mapped.Type.toUpperCase() === target.type.toUpperCase()
      && mapped.Name.toLowerCase() === target.name.toLowerCase()
      && mapped.Value === target.value;
  }

  async addDomainRecord(
    name: string,
    type: string,
    value: string,
    _line?: string,
    ttl = 600,
    mx = 1,
    _weight?: number,
    _remark?: string
  ): Promise<string | null> {
    try {
      if (!this.config.domain) {
        return null;
      }

      const item = this.convertRecordItem(name, type, value, mx);
      item.ttl = toNumber(ttl, 600);

      // 读全量 → 追加 → 整体保存（PUT 是全量语义）；同域名写操作串行，避免lost update
      return await withDomainLock(String(this.config.domain), async () => {
        const items = await this.fetchAllRawRecords();
        items.push(item);
        await this.saveAllRawRecords(items);
        return `${type}|${name}|${value}|${mx}`;
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
    _weight?: number,
    _remark?: string
  ): Promise<boolean> {
    try {
      if (!this.config.domain) {
        return false;
      }

      const target = this.parseRecordId(recordId);
      return await withDomainLock(String(this.config.domain), async () => {
        const items = await this.fetchAllRawRecords();
        const idx = items.findIndex((row) => this.matchesRecord(row, target));
        if (idx === -1) {
          this.error = '未找到要更新的记录（可能已被外部修改）';
          return false;
        }

        const next = this.convertRecordItem(name, type, value, mx);
        next.ttl = toNumber(ttl, 600);
        items[idx] = next;

        // 读全量 → 替换目标行 → 整体保存
        await this.saveAllRawRecords(items);
        return true;
      });
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    try {
      if (!this.config.domain) {
        return false;
      }

      // 官方 DELETE /v1/dns/records/{domain} 不带请求体（等价「清空该域名全部记录」），
      // 想删单条只能「读全量 → 过滤 → 整体保存」。
      const target = this.parseRecordId(recordId);
      return await withDomainLock(String(this.config.domain), async () => {
        const items = await this.fetchAllRawRecords();
        const remaining = items.filter((row) => !this.matchesRecord(row, target));
        if (remaining.length === items.length) {
          this.error = '未找到要删除的记录（可能已被外部删除）';
          return false;
        }

        await this.saveAllRawRecords(remaining);
        return true;
      });
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async setDomainRecordStatus(_recordId: string, _status: number): Promise<boolean> {
    this.error = 'Spaceship does not support record status toggle';
    return false;
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    return [{ id: '0', name: '默认' }];
  }

  async getMinTTL(): Promise<number> {
    return 60;
  }

  async addDomain(_domain: string): Promise<boolean> {
    this.error = 'Spaceship does not support domain registration via API';
    return false;
  }

  private convertRecordItem(name: string, type: string, value: string, mx: number): Dict {
    const item: Dict = { type, name };

    if (type === 'MX') {
      item.exchange = value;
      item.preference = mx;
    } else if (type === 'TXT') {
      item.value = value;
    } else if (type === 'CNAME') {
      item.cname = value;
    } else if (type === 'ALIAS') {
      item.aliasName = value;
    } else if (type === 'NS') {
      item.nameserver = value;
    } else if (type === 'PTR') {
      item.pointer = value;
    } else if (type === 'CAA') {
      const parts = value.split(' ', 3);
      if (parts.length >= 3) {
        item.flag = toNumber(parts[0], 0);
        item.tag = parts[1];
        item.value = parts[2].replace(/^"|"$/g, '');
      }
    } else if (type === 'SRV') {
      const parts = value.split(' ', 4);
      if (parts.length >= 4) {
        item.priority = toNumber(parts[0], 0);
        item.weight = toNumber(parts[1], 0);
        item.port = toNumber(parts[2], 0);
        item.target = parts[3];
      }
    } else {
      item.address = value;
    }
    return item;
  }

  private mapRecord(row: Dict): DnsRecord {
    const type = safeString(row.type);
    let value = '';
    let mx = 0;

    if (type === 'MX') {
      value = safeString(row.exchange);
      mx = toNumber(row.preference, 0);
    } else if (type === 'CNAME') {
      value = safeString(row.cname);
    } else if (type === 'TXT') {
      value = safeString(row.value);
    } else if (type === 'PTR') {
      value = safeString(row.pointer);
    } else if (type === 'NS') {
      value = safeString(row.nameserver);
    } else if (type === 'CAA') {
      value = `${row.flag} ${row.tag} "${row.value}"`;
    } else if (type === 'SRV') {
      value = `${row.priority} ${row.weight} ${row.port} ${row.target}`;
    } else if (type === 'ALIAS') {
      value = safeString(row.aliasName);
    } else {
      value = safeString(row.address);
    }

    return {
      RecordId: `${type}|${row.name}|${value}|${mx}`,
      Domain: this.config.domain || '',
      Name: safeString(row.name),
      Type: type,
      Value: value,
      Line: 'default',
      TTL: toNumber(row.ttl, 600),
      MX: mx,
      Status: 1,
      Weight: undefined,
      Remark: undefined,
      UpdateTime: undefined,
    };
  }
}
