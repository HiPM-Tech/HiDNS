import { createProviderAdapterLogger, DnsAdapter, DnsRecord, DomainInfo, PageResult, fetchWithFallback, resolveDomainIdHelper, normalizeRrName, safeString, toNumber, Dict, resolveProviderLine } from '../internal';
/**
 * Example DNS Provider Adapter - 示例 DNS 提供商适配器
 *
 * 这个文件展示了如何实现一个新的 DNS 提供商适配器。
 * 复制此文件并重命名，然后按照注释实现各个方法。
 *
 * 实现步骤：
 * 1) 定义配置接口（Config Interface）
 * 2) 实现适配器类，继承 BaseAdapter
 * 3) 实现抽象方法：mapRecord、normalizeLine、mapProviderError
 * 4) 实现必需方法：check、getDomainList、getDomainRecords 等
 * 5) 在 index.ts 中导出适配器
 */

import { buildAuthHeaders, authenticatedRequest, type ExampleAuthConfig } from './auth';

const log = createProviderAdapterLogger('Example');
// ==================== 配置接口示例 ====================

/**
 * 提供商配置接口
 * - domain: 当前操作的域名（可选，手动添加时传入）
 * - domainId: 域名在提供商处的唯一标识（可选，通过 resolveDomainId 解析）
 * - apiKey/apiSecret: 提供商 API 凭证
 * - useProxy: 是否使用代理
 */
interface ExampleConfig extends ExampleAuthConfig {
  domain?: string;
  domainId?: string;
}

// ==================== 适配器实现示例 ====================

/**
 * 示例 DNS 提供商适配器
 *
 * 命名规范：{ProviderName}Adapter
 * 例如：CloudflareAdapter、AliyunAdapter
 */
export class ExampleAdapter implements DnsAdapter {
  private config: ExampleConfig;
  private baseUrl = 'https://api.example.com/v1';
  private error: string = '';

  constructor(config: Record<string, string>) {
    this.config = {
      apiKey: safeString(config.apiKey || ''),
      apiSecret: safeString(config.apiSecret || ''),
      domain: safeString(config.domain),
      domainId: safeString(config.zoneId), // zoneId 是前端表单字段名
      useProxy: !!config.useProxy,
    };
  }

  /**
   * 获取最后的错误信息
   */
  getError(): string {
    return this.error;
  }

  // ==================== HTTP 请求工具方法 ====================

  /**
   * 发送 HTTP 请求
   * @param method HTTP 方法
   * @param path API 路径
   * @param params 请求参数
   */
  private async request<T>(method: string, path: string, params?: Dict): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    let body: string | undefined;

    if (method === 'GET' && params) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        query.set(key, String(value));
      }
      url += '?' + query.toString();
    } else if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
      body = JSON.stringify(params);
    }

    log.sub('API').tag('REQUEST').debug('Provider request', { method: method, url: url, params: undefined });

    const options: RequestInit = {
      method,
      headers: buildAuthHeaders(this.config),
      body,
    };

    const res = await authenticatedRequest(url, this.config, options);
    const data = (await res.json()) as Dict;

    if (!res.ok) {
      throw new Error(this.mapProviderError(data) || `Request failed: ${res.status}`);
    }

    return data as T;
  }

  // ==================== Domain ID 解析（可选）====================

  /**
   * 解析 Domain ID
   * 当 config.domainId 未设置时，尝试通过域名搜索获取
   * 如果提供商 API 使用 domain name 而不是 domain ID，可以省略此方法
   */
  private async resolveDomainId(): Promise<string | null> {
    return resolveDomainIdHelper(this.config, this.getDomainList.bind(this), 'Example');
  }

  // ==================== 必需实现的方法 ====================

  /**
   * 检查提供商连接是否正常
   * 用于验证 API 凭证是否正确
   */
  async check(): Promise<boolean> {
    try {
      await this.getDomainList();
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  /**
   * 获取域名列表
   * @param keyword 搜索关键词（可选）
   * @param page 页码（从1开始）
   * @param pageSize 每页数量
   */
  async getDomainList(keyword?: string, page = 1, pageSize = 50): Promise<PageResult<DomainInfo>> {
    try {
      // 调用提供商 API 获取域名列表
      const data = await this.request<{ domains: Array<{ id: string; name: string; count?: number }>; total: number }>(
        'GET',
        '/domains',
        { page, limit: pageSize, search: keyword }
      );

      const list = (data.domains || []).map((item) => ({
        Domain: item.name,
        ThirdId: item.id, // 域名在提供商处的唯一标识
        RecordCount: item.count,
      }));

      return { total: data.total || list.length, list };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      log.error('getDomainList failed', this.error);
      return { total: 0, list: [] };
    }
  }

  /**
   * 获取域名解析记录列表
   * @param page 页码
   * @param pageSize 每页数量
   * @param keyword 搜索关键词
   * @param subdomain 子域名过滤
   * @param value 记录值过滤
   * @param type 记录类型过滤
   * @param line 线路过滤
   * @param status 状态过滤
   */
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
      // 如果需要 domainId，先解析
      const domainId = await this.resolveDomainId();
      if (!domainId) {
        return { total: 0, list: [] };
      }

      // 构建查询参数
      const params: Dict = { page, limit: pageSize };
      if (subdomain) params.name = subdomain;
      if (type) params.type = type;
      if (line) params.line = this.normalizeLine(line);
      if (status !== undefined) params.status = status === 1 ? 'active' : 'disabled';

      const data = await this.request<{ records: Dict[]; total: number }>(
        'GET',
        `/domains/${domainId}/records`,
        params
      );

      let list = (data.records || []).map((row) => this.mapRecord(row));

      // 客户端过滤（如果 API 不支持某些过滤条件）
      if (keyword) {
        const lower = keyword.toLowerCase();
        list = list.filter((r) =>
          r.Name.toLowerCase().includes(lower) ||
          r.Value.toLowerCase().includes(lower)
        );
      }
      if (value) {
        list = list.filter((r) => r.Value === value);
      }

      return { total: data.total || list.length, list };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return { total: 0, list: [] };
    }
  }

  /**
   * 获取单条记录详情
   * @param recordId 记录 ID
   */
  async getDomainRecordInfo(recordId: string): Promise<DnsRecord | null> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) return null;

      const data = await this.request<Dict>('GET', `/domains/${domainId}/records/${recordId}`);
      return this.mapRecord(data);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  /**
   * 添加解析记录
   * @param name 主机记录（如 www, @, *）
   * @param type 记录类型（如 A, CNAME, MX）
   * @param value 记录值
   * @param line 线路
   * @param ttl TTL（秒）
   * @param mx MX 优先级（仅 MX 类型使用）
   * @param weight 权重
   * @param remark 备注
   * @returns 新记录的 ID
   */
  async addDomainRecord(
    name: string,
    type: string,
    value: string,
    line?: string,
    ttl = 600,
    mx = 1,
    weight?: number,
    remark?: string
  ): Promise<string | null> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) return null;

      const body: Dict = {
        name: normalizeRrName(name),
        type,
        value,
        line: this.normalizeLine(line),
        ttl,
      };

      if (type === 'MX') body.priority = mx;
      if (weight !== undefined) body.weight = weight;
      if (remark) body.remark = remark;

      const data = await this.request<{ id: string }>('POST', `/domains/${domainId}/records`, body);
      return data.id || null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  /**
   * 更新解析记录
   * @param recordId 记录 ID
   * @param name 主机记录
   * @param type 记录类型
   * @param value 记录值
   * @param line 线路
   * @param ttl TTL
   * @param mx MX 优先级
   * @param weight 权重
   * @param remark 备注
   */
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
      const domainId = await this.resolveDomainId();
      if (!domainId) return false;

      const body: Dict = {
        name: normalizeRrName(name),
        type,
        value,
        line: this.normalizeLine(line),
        ttl,
      };

      if (type === 'MX') body.priority = mx;
      if (weight !== undefined) body.weight = weight;
      if (remark) body.remark = remark;

      await this.request('PUT', `/domains/${domainId}/records/${recordId}`, body);
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  /**
   * 删除解析记录
   * @param recordId 记录 ID
   */
  async deleteDomainRecord(recordId: string): Promise<boolean> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) return false;

      await this.request('DELETE', `/domains/${domainId}/records/${recordId}`);
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  /**
   * 设置记录状态（启用/禁用）
   * @param recordId 记录 ID
   * @param status 1=启用, 0=禁用
   */
  async setDomainRecordStatus(recordId: string, status: number): Promise<boolean> {
    try {
      const domainId = await this.resolveDomainId();
      if (!domainId) return false;

      await this.request('PUT', `/domains/${domainId}/records/${recordId}/status`, {
        status: status === 1 ? 'active' : 'disabled',
      });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  /**
   * 获取支持的线路列表
   */
  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    // 返回此提供商支持的线路，ID 和名称由适配器决定
    return [{ id: '0', name: '默认' }];
  }

  /**
   * 获取最小支持的 TTL
   */
  async getMinTTL(): Promise<number> {
    return 60; // 返回提供商支持的最小 TTL
  }

  /**
   * 添加域名到提供商
   * @param domain 域名
   */
  async addDomain(domain: string): Promise<boolean> {
    try {
      await this.request('POST', '/domains', { name: domain });
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  // ==================== 私有辅助方法 ====================

  /**
   * 将提供商记录格式映射为统一格式
   * @param source 提供商返回的记录数据
   */
  private mapRecord(source: Dict): DnsRecord {
    // 示例：根据提供商的实际返回格式调整
    return {
      RecordId: safeString(source.id),
      Domain: this.config.domain || '',
      Name: normalizeRrName(safeString(source.name)),
      Type: safeString(source.type),
      Value: safeString(source.value),
      Line: safeString(source.line) || 'default',
      TTL: toNumber(source.ttl, 600),
      MX: toNumber(source.priority, 0),
      Status: source.status === 'active' ? 1 : 0,
      Weight: source.weight === undefined ? undefined : toNumber(source.weight, 0),
      Remark: safeString(source.remark) || undefined,
      UpdateTime: safeString(source.updated_at) || undefined,
    };
  }

  /**
   * 统一线路参数
   * 将内部线路标识转换为提供商要求的格式
   * @param line 内部线路标识（如 '0', '10=0'）
   */
  private normalizeLine(line?: string): string {
    const lineMap: Record<string, string> = {
      '0': 'default',
      '10=0': 'telecom',
      '10=1': 'unicom',
      '10=3': 'mobile',
    };
    return lineMap[resolveProviderLine(line, '0')] || 'default';
  }

  /**
   * 映射提供商错误
   * 将提供商的错误响应转换为可读的错误信息
   * @param errorPayload 错误响应数据
   */
  private mapProviderError(errorPayload: unknown): string {
    const data = errorPayload as Dict;
    return safeString(data.message) || safeString(data.error) || '';
  }
}
