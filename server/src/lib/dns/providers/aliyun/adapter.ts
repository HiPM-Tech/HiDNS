import { createProviderAdapterLogger, DnsRecord, DomainInfo, PageResult, AliyunRpcAdapter, asArray, Dict, normalizeRrName, safeString, toNumber, toRecordStatus, resolveProviderLine } from '../internal';

const log = createProviderAdapterLogger('Aliyun');
export class AliyunAdapter extends AliyunRpcAdapter {
  private readonly domain: string;

  constructor(config: Record<string, string>) {
    super(config);
    this.domain = safeString(config.domain);
  }

  protected endpoint(): string {
    return 'https://alidns.aliyuncs.com/';
  }

  private mapRecord(item: Dict): DnsRecord {
    return {
      RecordId: safeString(item.RecordId),
      Domain: safeString(item.DomainName) || this.domain,
      Name: normalizeRrName(safeString(item.RR)),
      Type: safeString(item.Type),
      Value: safeString(item.Value),
      Line: this.normalizeLine(safeString(item.Line)) ?? 'default',
      TTL: toNumber(item.TTL, 600),
      MX: toNumber(item.Priority, 0),
      Status: toRecordStatus(item.Status),
      Weight: item.Weight === undefined ? undefined : toNumber(item.Weight, 0),
      Remark: safeString(item.Remark) || undefined,
      UpdateTime: safeString(item.UpdateTimestamp) || safeString(item.UpdatedAt) || undefined,
    };
  }

  private normalizeLine(line?: string): string | undefined {
    const convertDict: Record<string, string> = {
      '10=1': 'unicom',
      '10=0': 'telecom',
      '10=3': 'mobile',
      '10=2': 'edu',
      '3=0': 'oversea',
      '10=22': 'btvn',
      '80=0': 'search',
      '7=0': 'internal',
    };
    if (!line) return undefined;
    // '0' 已经是标准格式，不需要转换
    if (line === '0') return '0';
    return convertDict[line] ?? line;
  }

  async check(): Promise<boolean> {
    try {
      await this.rpcCall('DescribeDomains', { PageSize: 1, PageNumber: 1 });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async getDomainList(keyword?: string, page = 1, pageSize = 50): Promise<PageResult<DomainInfo>> {
    try {
      const data = await this.rpcCall<Dict>('DescribeDomains', {
        PageNumber: page,
        PageSize: pageSize,
        KeyWord: keyword,
      });
      const list = asArray<Dict>((data.Domains as Dict | undefined)?.Domain).map((item) => ({
        Domain: safeString(item.DomainName),
        ThirdId: safeString(item.DomainId),
        RecordCount: item.RecordCount === undefined ? undefined : toNumber(item.RecordCount, 0),
      }));
      return { total: toNumber(data.TotalCount, list.length), list };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      log.error('getDomainList failed', { error: { name: 'AliyunApiError', message: this.error } });
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
    line?: string,
    status?: number
  ): Promise<PageResult<DnsRecord>> {
    try {
      const params: Record<string, unknown> = {
        DomainName: this.domain,
        PageNumber: page,
        PageSize: pageSize,
      };
      if (subdomain || value || type || line) {
        params.SearchMode = 'ADVANCED';
        params.RRKeyWord = subdomain;
        params.ValueKeyWord = value;
        params.Type = type;
        params.Line = this.normalizeLine(line);
      } else if (keyword) {
        params.KeyWord = keyword;
      }
      if (status !== undefined) {
        params.Status = status === 1 ? 'Enable' : 'Disable';
      }
      const data = await this.rpcCall<Dict>('DescribeDomainRecords', params);
      const list = asArray<Dict>((data.DomainRecords as Dict | undefined)?.Record).map((item) => this.mapRecord(item));
      return { total: toNumber(data.TotalCount, list.length), list };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      log.warn('getDomainRecords failed', { error: { name: 'AliyunApiError', message: this.error } });
      return { total: 0, list: [] };
    }
  }

  async getDomainRecordInfo(recordId: string): Promise<DnsRecord | null> {
    try {
      const data = await this.rpcCall<Dict>('DescribeDomainRecordInfo', { RecordId: recordId });
      return this.mapRecord(data);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  async addDomainRecord(name: string, type: string, value: string, line?: string, ttl = 600, mx = 0, weight?: number, remark?: string): Promise<string | null> {
    try {
      const data = await this.rpcCall<Dict>('AddDomainRecord', {
        DomainName: this.domain,
        RR: normalizeRrName(name),
        Type: type,
        Value: value,
        Line: this.normalizeLine(resolveProviderLine(line, 'default')),
        TTL: ttl,
        Priority: type === 'MX' ? mx : undefined,
        Weight: weight,
      });
      if (remark) {
        await this.rpcCall('UpdateDomainRecordRemark', { RecordId: safeString(data.RecordId), Remark: remark });
      }
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
    mx = 0,
    weight?: number,
    remark?: string
  ): Promise<boolean> {
    try {
      await this.rpcCall('UpdateDomainRecord', {
        RecordId: recordId,
        RR: normalizeRrName(name),
        Type: type,
        Value: value,
        Line: this.normalizeLine(resolveProviderLine(line, 'default')),
        TTL: ttl,
        Priority: type === 'MX' ? mx : undefined,
        Weight: weight,
      });
      if (remark !== undefined) {
        await this.rpcCall('UpdateDomainRecordRemark', { RecordId: recordId, Remark: remark });
      }
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    try {
      await this.rpcCall('DeleteDomainRecord', { RecordId: recordId });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async setDomainRecordStatus(recordId: string, status: number): Promise<boolean> {
    try {
      await this.rpcCall('SetDomainRecordStatus', {
        RecordId: recordId,
        Status: status === 1 ? 'Enable' : 'Disable',
      });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    try {
      const data = await this.rpcCall<Dict>('DescribeDomainInfo', {
        DomainName: this.domain,
        NeedDetailAttributes: true,
      });
      const lines = asArray<Dict>((data.RecordLines as Dict | undefined)?.RecordLine).map((row) => ({
        id: safeString(row.LineCode),
        name: safeString(row.LineDisplayName),
      }));
      return lines.length > 0 ? lines : [{ id: 'default', name: '默认' }];
    } catch (e) {
      // 上游失败必须抛出：返回 [{id:'0'}] 会让调用方把「查询失败」当成「只有默认线路」
      this.error = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  async getMinTTL(): Promise<number> {
    try {
      const data = await this.rpcCall<Dict>('DescribeDomainInfo', {
        DomainName: this.domain,
        NeedDetailAttributes: true,
      });
      return toNumber(data.MinTtl, 600);
    } catch {
      return 600;
    }
  }

  async addDomain(domain: string): Promise<boolean> {
    try {
      await this.rpcCall('AddDomain', { DomainName: domain });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }
}
