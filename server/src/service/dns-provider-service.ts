/**
 * DNS 提供商服务
 *
 * 封装 DNS 适配器调用逻辑，供 MCP 和其他模块复用
 */

import { DnsAdapter, DnsRecord, PageResult } from '../lib/dns/DnsInterface';
import { createAdapter } from '../lib/dns/DnsHelper';
import { findRecordMeta } from '../lib/dns/record-lookup';
import {
  hasDomainEventSubscribers,
  publishRecordEvent,
  type ActorSource,
} from '../lib/domain-event-bus';
import { DomainOperations, DnsAccountOperations } from '../db/bal/business-adapter';
import { createLogger } from '../lib/logger';
import type { Domain, DnsAccount } from '../types';
import { getProviderDefinitions } from '../lib/dns/providers/registry';
import { normalizeProviderType } from '../lib/dns/providerAlias';
import { getProviderLinesCached } from './providerLines';
import { normalizeLineList } from '../lib/dns/line-normalizer';

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

    // 适配器可能把「上游失败」折叠成空结果，与「真的 0 条」同形。
    // 调用前清空上次错误、调用后若为空且本次有错误，则按失败抛出（fail-closed）。
    adapter.clearError?.();
    const result = await adapter.getDomainRecords(
      options?.page || 1,
      options?.pageSize || 100,
      options?.keyword,
      options?.subdomain,
      options?.value,
      options?.type,
      options?.line,
      options?.status !== undefined ? options.status : undefined
    );

    // 适配器可能把「上游失败」折叠成空结果，与「真的 0 条」同形。
    // 这里用「本次调用后的错误」做 fail-closed：空结果 + 有错误 → 抛给上层 500，而不是伪装成空列表。
    if (result.list.length === 0 && result.total === 0 && adapter.getError()) {
      throw new Error(`读取记录失败：${adapter.getError()}`);
    }
    return result;
  }

  /**
   * 获取可用线路列表
   */
  static async getLines(domainId: number): Promise<Array<{ id: string; name?: string }>> {
    const adapter = await this.getAdapter(domainId);

    // 内置线路直接返回（不联网、不入缓存）；动态线路走「缓存 3600s → 拉取 → 失败只返回默认」。
    const domain = await DomainOperations.getById(domainId) as { account_id?: number } | undefined;
    const account = domain?.account_id
      ? await DnsAccountOperations.getById(Number(domain.account_id)) as { type?: string } | undefined
      : undefined;
    const providerType = normalizeProviderType(String(account?.type ?? ''));
    const definition = getProviderDefinitions().find((item) => item.type === providerType);
    if (!definition || definition.lineSource === 'builtin') {
      return normalizeLineList(await adapter.getRecordLines(), definition?.defaultLine ?? '');
    }

    const result = await getProviderLinesCached({
      providerType,
      defaultLine: definition.defaultLine,
      fetchLines: () => adapter.getRecordLines(),
    });
    // 默认线路由中间层统一改写为「默认」并置于首位
    return normalizeLineList(result.lines, definition.defaultLine);
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
    const recordId = await adapter.addDomainRecord(
      name,
      type,
      value,
      options?.line,
      options?.ttl || 600,
      options?.mx || 0,
      options?.weight,
      options?.remark
    );
    if (recordId) {
      await this.publishMutation({
        action: 'created',
        domainId,
        recordId,
        name,
        type,
        value,
      });
    }
    return recordId;
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
    // 仅在存在订阅者时才回查旧值，避免给热路径增加固定开销
    const previous = hasDomainEventSubscribers() ? await findRecordMeta(adapter, recordId) : null;
    const ok = await adapter.updateDomainRecord(
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
    if (ok) {
      await this.publishMutation({
        action: 'updated',
        domainId,
        recordId,
        name,
        type,
        value,
        oldValue: previous?.Value,
      });
    }
    return ok;
  }

  /**
   * 删除记录
   */
  static async deleteRecord(recordId: string, domainId: number): Promise<boolean> {
    const adapter = await this.getAdapter(domainId);
    // 删除事件需要记录类型；无订阅者时不回查
    const previous = hasDomainEventSubscribers() ? await findRecordMeta(adapter, recordId) : null;
    const ok = await adapter.deleteDomainRecord(recordId);
    if (ok && previous) {
      await this.publishMutation({
        action: 'deleted',
        domainId,
        recordId,
        name: previous.Name,
        type: previous.Type,
        value: previous.Value,
      });
    }
    return ok;
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
   * 主核心事件主线：服务层写入的统一发布口。
   * 无订阅者时零成本；任何异常都不影响业务结果。
   */
  private static async publishMutation(input: {
    action: 'created' | 'updated' | 'deleted' | 'status_changed';
    domainId: number;
    recordId: string;
    name?: string;
    type?: string;
    value?: string;
    oldValue?: string;
    source?: ActorSource;
  }): Promise<void> {
    if (!hasDomainEventSubscribers()) return;
    if (!input.type) return;
    try {
      const domain = (await DomainOperations.getById(input.domainId)) as unknown as
        | { id: number; name: string; account_id?: number }
        | undefined;
      if (!domain) return;
      publishRecordEvent({
        action: input.action,
        domain: { id: domain.id, name: domain.name, accountId: domain.account_id },
        record: {
          id: input.recordId,
          name: input.name ?? '',
          type: input.type,
          value: input.value,
          oldValue: input.oldValue,
        },
        actor: { source: input.source ?? 'system' },
      });
    } catch {
      // 事件发布为旁路
    }
  }

  /**
   * 设置记录状态（启用/禁用）
   */
  static async setRecordStatus(recordId: string, domainId: number, enabled: boolean): Promise<boolean> {
    const adapter = await this.getAdapter(domainId);
    const previous = hasDomainEventSubscribers() ? await findRecordMeta(adapter, recordId) : null;
    const ok = await adapter.setDomainRecordStatus(recordId, enabled ? 1 : 0);
    if (ok && previous) {
      await this.publishMutation({
        action: 'status_changed',
        domainId,
        recordId,
        name: previous.Name,
        type: previous.Type,
        value: previous.Value,
      });
    }
    return ok;
  }
}
