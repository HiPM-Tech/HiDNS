import { createProviderAdapterLogger } from '../internal';
import {
  BaseAdapter,
  DnsRecord,
  DomainInfo,
  PageResult,
} from '../internal';
import { validateCredentials } from './auth';
import { listAllDomains, parseDpdnsDate } from './renewal';

const log = createProviderAdapterLogger('DPDNS');

/**
 * ⚠️ DigitalPlat Domains 适配器 — 逆向实现
 *
 * 当前实现：仅支持续期操作（通过 remember_token 认证）。
 * DNS 记录管理返回空结果（该功能将由未来的 dodns 官方 API key 实现提供）。
 *
 * ⚠️ 注意：dodns 将作为独立的提供商注册，使用官方 API key 认证。
 */
export class DpdnsReverseAdapter extends BaseAdapter {
  private rememberToken: string;

  constructor(config: Record<string, string>) {
    super();
    this.rememberToken = config.rememberToken || '';
  }

  /** 验证 remember_token 有效性 */
  async check(): Promise<boolean> {
    if (!this.rememberToken) return false;
    try {
      const valid = await validateCredentials({ rememberToken: this.rememberToken });
      if (!valid) {
        this.error = 'Invalid remember_token';
      }
      return valid;
    } catch (e: any) {
      this.error = e.message || 'Unknown error';
      return false;
    }
  }

  async getDomainList(keyword?: string, page?: number, pageSize?: number): Promise<PageResult<DomainInfo>> {
    try {
      const domains = await listAllDomains({ rememberToken: this.rememberToken });
      const list = domains.map((d) => ({
        Domain: d.domain,
        ThirdId: d.domain,
        ExpiresAt: parseDpdnsDate(d.expiry_date),
      }));
      log.info(`Fetched ${list.length} domains from dpdns API`);
      return { total: list.length, list };
    } catch (e: any) {
      log.error('Failed to fetch domain list', { error: e.message });
      return { total: 0, list: [] };
    }
  }

  async getDomainRecords(
    page?: number,
    pageSize?: number,
    keyword?: string,
    subdomain?: string,
    value?: string,
    type?: string,
    line?: string,
    status?: number,
  ): Promise<PageResult<DnsRecord>> {
    log.debug('getDomainRecords called (not implemented)');
    this.error = this.error || '读取记录失败：未解析到域名或上游返回空结果';
    return { total: 0, list: [] };
  }

  async getDomainRecordInfo(recordId: string): Promise<DnsRecord | null> {
    return null;
  }

  async addDomainRecord(
    name: string,
    type: string,
    value: string,
    line?: string,
    ttl?: number,
    mx?: number,
    weight?: number,
    remark?: string,
  ): Promise<string | null> {
    return null;
  }

  async updateDomainRecord(
    recordId: string,
    name: string,
    type: string,
    value: string,
    line?: string,
    ttl?: number,
    mx?: number,
    weight?: number,
    remark?: string,
  ): Promise<boolean> {
    return false;
  }

  async deleteDomainRecord(recordId: string): Promise<boolean> {
    return false;
  }

  async setDomainRecordStatus(recordId: string, status: number): Promise<boolean> {
    return false;
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    // 反向代理只支持默认线路（builtin），显式声明而不是返回空数组
    return [{ id: '0', name: '默认' }];
  }

  async getMinTTL(): Promise<number> {
    return 600;
  }

  async addDomain(domain: string): Promise<boolean> {
    return false;
  }
}