import { createProviderAdapterLogger, DnsRecord, DomainInfo, PageResult, asArray, Dict, normalizeRrName, safeString, TencentCloudAdapter, toNumber, toRecordStatus, resolveProviderLine, requireNumericRecordId } from '../internal';

const log = createProviderAdapterLogger('Dnspod');
export class DnspodAdapter extends TencentCloudAdapter {
  private readonly domain: string;

  constructor(config: Record<string, string>) {
    super(config);
    this.domain = safeString(config.domain);
  }

  protected service(): string {
    return 'dnspod';
  }

  protected endpoint(): string {
    return 'dnspod.tencentcloudapi.com';
  }

  protected version(): string {
    return '2021-03-23';
  }

  private convertLineCode(line?: string): string | undefined {
    const convertDict: Record<string, string> = {
      default: '0',
      unicom: '10=1',
      telecom: '10=0',
      mobile: '10=3',
      edu: '10=2',
      oversea: '3=0',
      btvn: '10=22',
      search: '80=0',
      internal: '7=0',
    };
    if (!line) return undefined;
    return convertDict[line] ?? line;
  }

  /** DNSPod 的 RecordLine 必填且是「线路名称」，ID 只是可选加速字段 */
  private convertLineIdToName(lineId: string): string {
    const names: Record<string, string> = {
      '0': '默认',
      '10=0': '电信',
      '10=1': '联通',
      '10=3': '移动',
      '10=2': '教育网',
      '3=0': '境外',
      '10=22': 'BGP',
      '80=0': '搜索引擎',
      '7=0': '内网',
    };
    return names[lineId] ?? lineId;
  }

  private convertType(type?: string): string | undefined {
    if (!type) return type;
    if (type === 'REDIRECT_URL') return '显性URL';
    if (type === 'FORWARD_URL') return '隐性URL';
    return type;
  }

  private convertTypeId(type?: string): string | undefined {
    if (!type) return type;
    if (type === '显性URL') return 'REDIRECT_URL';
    if (type === '隐性URL') return 'FORWARD_URL';
    return type;
  }

  // DNSPod 系统 NS 记录域名后缀（含新旧套餐），这些是托管商的默认 NS 记录
  // https://docs.dnspod.cn/dns/dns-plan-address/
  private static readonly DNSPOD_NS_SUFFIXES = [
    '.dnspod.net', '.dnspod.com',
    '.dnsv2.com', '.dnsv3.com', '.dnsv4.com', '.dnsv5.com',
    '.tencent-cloud.com',
  ];

  private isSystemNsRecord(item: Dict): boolean {
    const type = safeString(item.Type);
    const name = safeString(item.Name);
    if (type !== 'NS') return false;
    // 只过滤 @ 记录的 NS（托管商默认 NS），保留子域名 NS 记录（DNS 委派）
    if (name && name !== '@') return false;
    // 去除末尾点号再匹配，因为 DNSPod 可能返回带或不带结尾点的 NS 值
    const value = safeString(item.Value).toLowerCase().replace(/\.+$/, '');
    return DnspodAdapter.DNSPOD_NS_SUFFIXES.some(suffix => value.endsWith(suffix));
  }

  private mapRecord(item: Dict): DnsRecord {
    return {
      RecordId: String(item.RecordId ?? item.RecordID ?? item.Id ?? ''),
      Domain: this.domain,
      Name: normalizeRrName(safeString(item.Name)),
      Type: this.convertTypeId(safeString(item.Type)) || safeString(item.Type),
      Value: safeString(item.Value),
      Line: safeString(item.LineId) || safeString(item.RecordLineId) || safeString(item.Line) || '0',
      TTL: toNumber(item.TTL, 600),
      MX: toNumber(item.MX, 0),
      Status: toRecordStatus(item.Status),
      Weight: item.Weight === undefined ? undefined : toNumber(item.Weight, 0),
      Remark: safeString(item.Remark) || undefined,
      UpdateTime: safeString(item.UpdatedOn) || undefined,
    };
  }

  async check(): Promise<boolean> {
    try {
      await this.call('DescribeDomainList', { Offset: 0, Limit: 1 });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async getDomainList(keyword?: string, page = 1, pageSize = 50): Promise<PageResult<DomainInfo>> {
    try {
      const offset = (page - 1) * pageSize;
      const data = await this.call<Dict>('DescribeDomainList', {
        Offset: offset,
        Limit: pageSize,
        Keyword: keyword || undefined,
      });
      const list = asArray<Dict>(data.DomainList).map((item) => ({
        Domain: safeString(item.Name),
        ThirdId: String(item.DomainId ?? ''),
        RecordCount: item.RecordCount === undefined ? undefined : toNumber(item.RecordCount, 0),
      }));
      const total = toNumber((data.DomainCountInfo as Dict | undefined)?.DomainTotal, list.length);
      return { total, list };
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
    line?: string,
    status?: number
  ): Promise<PageResult<DnsRecord>> {
    try {
      const offset = (page - 1) * pageSize;
      const hasFilterListPath = status !== undefined || !!value;
      if (hasFilterListPath) {
        const payload: Dict = {
          Domain: this.domain,
          Offset: offset,
          Limit: pageSize,
          SubDomain: subdomain || undefined,
          Keyword: keyword || undefined,
          RecordValue: value || undefined,
          RecordType: type ? [this.convertType(type)] : undefined,
          RecordLineId: line || undefined,
          RecordStatus: status === undefined ? undefined : [status === 1 ? 'ENABLE' : 'DISABLE'],
        };
        const data = await this.call<Dict>('DescribeRecordFilterList', payload);
        const rawFilter = asArray<Dict>(data.RecordList);
        const list = rawFilter.filter(r => !this.isSystemNsRecord(r)).map((item) => this.mapRecord(item));
        const total = toNumber((data.RecordCountInfo as Dict | undefined)?.TotalCount, list.length);
        return { total, list };
      }

      const data = await this.call<Dict>('DescribeRecordList', {
        Domain: this.domain,
        Subdomain: subdomain || undefined,
        RecordType: this.convertType(type),
        RecordLineId: this.convertLineCode(line),
        Keyword: keyword || undefined,
        Offset: offset,
        Limit: pageSize,
      });
      const rawList = asArray<Dict>(data.RecordList);
      const list = rawList.filter(r => !this.isSystemNsRecord(r)).map((item) => this.mapRecord(item));
      const total = toNumber((data.RecordCountInfo as Dict | undefined)?.TotalCount, list.length);
      return { total, list };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.error = msg;
      // ResourceNotFound.NoDataOfRecord 表示"无更多记录"或"记录列表为空"
      // 这是正常的业务状态，不是异常，返回空列表让调用方正常处理
      if (msg.includes('No records on the list') || msg.includes('记录列表为空')) {
        return { total: 0, list: [] };
      }
      // 其他错误（认证失败、网络超时、参数错误等）是真正的异常，必须向上抛
      throw e;
    }
  }

  async getDomainRecordInfo(recordId: string): Promise<DnsRecord | null> {
    try {
      const data = await this.call<Dict>('DescribeRecord', {
        Domain: this.domain,
        RecordId: requireNumericRecordId(recordId),
      });
      const info = (data.RecordInfo as Dict | undefined) ?? {};
      return {
        RecordId: String(info.Id ?? recordId),
        Domain: this.domain,
        Name: normalizeRrName(safeString(info.SubDomain)),
        Type: this.convertTypeId(safeString(info.RecordType)) || safeString(info.RecordType),
        Value: safeString(info.Value),
        Line: safeString(info.RecordLineId) || '0',
        TTL: toNumber(info.TTL, 600),
        MX: toNumber(info.MX, 0),
        Status: toNumber(info.Enabled, 1) === 1 ? 1 : 0,
        Weight: info.Weight === undefined ? undefined : toNumber(info.Weight, 0),
        Remark: safeString(info.Remark) || undefined,
        UpdateTime: safeString(info.UpdatedOn) || undefined,
      };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  async addDomainRecord(name: string, type: string, value: string, line?: string, ttl = 600, mx = 1, weight?: number, remark?: string): Promise<string | null> {
    try {
      const data = await this.call<Dict>('CreateRecord', {
        Domain: this.domain,
        SubDomain: normalizeRrName(name),
        RecordType: this.convertType(type),
        Value: value,
        // DNSPod 的 RecordLine 必填（名称），RecordLineId 为可选 ID
        RecordLine: this.convertLineIdToName(this.convertLineCode(resolveProviderLine(line, '0')) ?? '0'),
        RecordLineId: this.convertLineCode(resolveProviderLine(line, '0')),
        TTL: ttl,
        MX: type === 'MX' ? mx : undefined,
        Weight: weight,
      });
      const recordId = String(data.RecordId ?? '');
      if (remark !== undefined && recordId) {
        await this.call('ModifyRecordRemark', {
          Domain: this.domain,
          RecordId: requireNumericRecordId(recordId),
          Remark: remark,
        });
      }
      return recordId || null;
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
    remark?: string
  ): Promise<boolean> {
    try {
      await this.call('ModifyRecord', {
        Domain: this.domain,
        RecordId: requireNumericRecordId(recordId),
        SubDomain: normalizeRrName(name),
        RecordType: this.convertType(type),
        Value: value,
        // RecordLine 必填（名称）；RecordLineId 为可选加速字段
        RecordLine: this.convertLineIdToName(this.convertLineCode(resolveProviderLine(line, '0')) ?? '0'),
        RecordLineId: this.convertLineCode(resolveProviderLine(line, '0')),
        TTL: ttl,
        MX: type === 'MX' ? mx : undefined,
        Weight: weight,
      });
      if (remark !== undefined) {
        await this.call('ModifyRecordRemark', {
          Domain: this.domain,
          RecordId: requireNumericRecordId(recordId),
          Remark: remark,
        });
      }
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    try {
      await this.call('DeleteRecord', {
        Domain: this.domain,
        RecordId: requireNumericRecordId(recordId),
      });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async setDomainRecordStatus(recordId: string, status: number): Promise<boolean> {
    try {
      await this.call('ModifyRecordStatus', {
        Domain: this.domain,
        RecordId: requireNumericRecordId(recordId),
        Status: status === 1 ? 'ENABLE' : 'DISABLE',
      });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    try {
      const data = await this.call<Dict>('DescribeRecordLineCategoryList', { Domain: this.domain });
      const lines: Array<{ id: string; name: string }> = [];
      const seen = new Set<string>();

      const walk = (nodes: Dict[]) => {
        for (const node of nodes) {
          const name = safeString(node.LineName);
          const lineId = safeString(node.LineId);
          const useful = Boolean(node.Useful);
          if (useful && lineId && name && !lineId.startsWith('N.') && !seen.has(lineId)) {
            seen.add(lineId);
            lines.push({ id: lineId, name });
          }
          const sub = asArray<Dict>(node.SubGroup);
          if (sub.length > 0) walk(sub);
        }
      };

      walk(asArray<Dict>(data.LineList));
      if (lines.length > 0) {
        log.info('getRecordLines success (category)', { domain: this.domain, count: lines.length });
        return lines;
      }
    } catch (e) {
      log.warn('getRecordLines category failed', {
        domain: this.domain,
        error: e instanceof Error ? e.message : String(e)
      });
    }

    try {
      const data = await this.call<Dict>('DescribeRecordLineList', { Domain: this.domain, DomainGrade: '' });
      const seen = new Set<string>();
      const merged: Array<{ id: string; name: string }> = [];
      for (const item of asArray<Dict>(data.LineList)) {
        const id = safeString(item.LineId);
        const name = safeString(item.Name);
        if (id && name && !id.startsWith('N.') && !seen.has(id)) {
          seen.add(id);
          merged.push({ id, name });
        }
      }
      for (const item of asArray<Dict>(data.LineGroupList)) {
        const id = safeString(item.LineId);
        const name = safeString(item.Name);
        if (id && name && !id.startsWith('N.') && !seen.has(id)) {
          seen.add(id);
          merged.push({ id, name });
        }
      }
      if (merged.length > 0) {
        log.info('getRecordLines success (list)', { domain: this.domain, count: merged.length });
        return merged;
      }
    } catch (e) {
      log.warn('getRecordLines list failed', {
        domain: this.domain,
        error: e instanceof Error ? e.message : String(e)
      });
    }

    // 动态线路不允许内置兜底：两次上游都失败时按失败处理
    this.error = '线路查询失败（dnspod）';
    throw new Error(this.error);
  }

  async getMinTTL(): Promise<number> {
    try {
      const data = await this.call<Dict>('DescribeDomainPurview', { Domain: this.domain });
      for (const item of asArray<Dict>(data.PurviewList)) {
        const name = safeString(item.Name);
        if (name === '记录 TTL 最低' || name === 'Min TTL value') {
          return toNumber(item.Value, 600);
        }
      }
      return 600;
    } catch {
      return 600;
    }
  }

  async addDomain(domain: string): Promise<boolean> {
    try {
      await this.call('CreateDomain', { Domain: domain });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }
}
