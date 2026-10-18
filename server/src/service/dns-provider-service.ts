/**
 * DNS 提供商服务
 *
 * 封装 DNS 适配器调用逻辑，供 MCP 和其他模块复用
 */

import { DnsAdapter, DnsRecord, PageResult } from '../lib/dns/DnsInterface';
import { createAdapter } from '../lib/dns/DnsHelper';
import { DomainOperations, DnsAccountOperations } from '../db/bal/business-adapter';
import { createLogger } from '../lib/logger';
import type { Domain, DnsAccount } from '../types';

const log = createLogger('DnsProviderService');
export class DnsProviderService {
  /**
   * 获取域名的 DNS 适配器
   */
  static async getAdapter(domainId: number): Promise<DnsAdapter> {
    // 1. 获取域名信息
    const domain = await DomainOperations.getById(domainId);
    if (!domain) {
      throw new Error(`Domain ${domainId} not found`);
    }

    return this.getAdapterForDomain(domain as unknown as Domain);
  }

  /**
   * 为域名创建适配器（内部方法）
   */
  private static async getAdapterForDomain(domain: Domain): Promise<DnsAdapter> {
    log.info('Getting adapter for domain', {
      domainId: domain.id,
      domainName: domain.name,
      accountId: domain.account_id,
      thirdId: domain.third_id,
    });

    // 2. 获取账号信息
    const account = await DnsAccountOperations.getById(domain.account_id as number) as DnsAccount | undefined;
    if (!account) {
      log.error('Account not found', { accountId: domain.account_id });
      throw new Error('Account not found');
    }

    log.info('Found account', {
      accountType: account.type,
      accountName: account.name,
    });

    // 3. 解析配置（MySQL JSON 返回对象，SQLite/PostgreSQL 返回字符串）
    const cfg = typeof account.config === 'string'
      ? JSON.parse(account.config) as Record<string, string>
      : account.config as Record<string, string>;

    // 4. HiDNS 特殊处理：使用 third_id 作为远程域名 ID
    const isHiDNS = account.type === 'hidns';
    const effectiveDomainId = isHiDNS && domain.third_id ? domain.third_id : String(domain.id);

    log.info('Creating adapter', {
      type: account.type,
      domain: domain.name,
      thirdId: domain.third_id,
      localDomainId: domain.id,
      effectiveDomainId,
      isHiDNS,
    });

    // 5. 创建适配器
    const adapter = createAdapter(
      account.type,
      cfg,
      domain.name as string,
      domain.third_id as string,
      effectiveDomainId
    );

    log.info('Adapter created successfully');
    return adapter;
  }

  /**
   * 按账号构建适配器（不依赖域名）。用于源站组等按账号+作用域访问的能力。
   */
  static async getAdapterByAccount(accountId: number, domainName = '', thirdId = ''): Promise<DnsAdapter> {
    const account = (await DnsAccountOperations.getById(accountId)) as unknown as DnsAccount | undefined;
    if (!account) throw new Error('Account not found');
    const cfg = typeof account.config === 'string'
      ? (JSON.parse(account.config) as Record<string, string>)
      : (account.config as Record<string, string>);
    return createAdapter(account.type, cfg, domainName, thirdId, thirdId);
  }

  /**
   * 获取域名记录（支持线路过滤）
   */
  static async getRecords(
    domainId: number,
    options?: {
      page?: number;
      pageSize?: number;
      keyword?: string;
      subdomain?: string;
      value?: string;
      type?: string;
      line?: string;
      status?: number;
    }
  ): Promise<PageResult<DnsRecord>> {
    const adapter = await this.getAdapter(domainId);

    return adapter.getDomainRecords(
      options?.page || 1,
      options?.pageSize || 100,
      options?.keyword,
      options?.subdomain,
      options?.value,
      options?.type,
      options?.line,
      options?.status !== undefined ? options.status : undefined
    );
  }

  /**
   * 获取可用线路列表
   */
  static async getLines(domainId: number): Promise<Array<{ id: string; name?: string }>> {
    const adapter = await this.getAdapter(domainId);
    return adapter.getRecordLines();
  }

  /**
   * 创建记录（支持线路）
   */
  static async createRecord(
    domainId: number,
    name: string,
    type: string,
    value: string,
    options?: {
      line?: string;
      ttl?: number;
      mx?: number;
      weight?: number;
      remark?: string;
    }
  ): Promise<string | null> {
    const adapter = await this.getAdapter(domainId);

    return adapter.addDomainRecord(
      name,
      type,
      value,
      options?.line,
      options?.ttl || 600,
      options?.mx || 0,
      options?.weight,
      options?.remark
    );
  }

  /**
   * 更新记录（支持线路）
   */
  static async updateRecord(
    recordId: string,
    domainId: number,
    name: string,
    type: string,
    value: string,
    options?: {
      line?: string;
      ttl?: number;
      mx?: number;
      weight?: number;
      remark?: string;
    }
  ): Promise<boolean> {
    const adapter = await this.getAdapter(domainId);

    return adapter.updateDomainRecord(
      recordId,
      name,
      type,
      value,
      options?.line,
      options?.ttl || 600,
      options?.mx || 0,
      options?.weight,
      options?.remark
    );
  }

  /**
   * 删除记录
   */
  static async deleteRecord(recordId: string, domainId: number): Promise<boolean> {
    const adapter = await this.getAdapter(domainId);
    return adapter.deleteDomainRecord(recordId);
  }

  /**
   * 获取单个记录详情
   */
  static async getRecordInfo(recordId: string, domainId: number): Promise<DnsRecord | null> {
    const adapter = await this.getAdapter(domainId);

    // 先尝试直接获取
    let record = await adapter.getDomainRecordInfo(recordId);

    // 如果失败，尝试从列表中查找
    if (!record) {
      const result = await adapter.getDomainRecords(1, 1000);
      record = result.list.find((item) => item.RecordId === recordId) ?? null;
    }

    return record;
  }

  /**
   * 设置记录状态（启用/禁用）
   */
  static async setRecordStatus(recordId: string, domainId: number, enabled: boolean): Promise<boolean> {
    const adapter = await this.getAdapter(domainId);
    return adapter.setDomainRecordStatus(recordId, enabled ? 1 : 0);
  }
}
