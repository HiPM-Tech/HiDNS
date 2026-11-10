import { createProviderAdapterLogger } from '../internal';
import {
  BaseAdapter,
  DnsRecord,
  DomainInfo,
  PageResult,
} from '../internal';
import { resolveSessionJar, validateCredentials, type DpdnsAuthConfig } from './auth';
import { listAllDomains, parseDpdnsDate } from './renewal';

export const DEFAULT_LINE = '0';

const log = createProviderAdapterLogger('DPDNS');

/**
 * DigitalPlat（dpdns_reverse）适配器。
 *
 * 该提供商只做 **域名续期**（capabilities.dns = null），DNS 记录相关方法是为了满足
 * DnsAdapter 接口而存在的空实现，路由层会按能力位拒绝记录操作。
 *
 * 认证：Bitwarden 导出的通行密钥 → 自动换签出 Cookie（见 auth.ts），
 * Cookie 落在账号配置的隐藏字段 sessionCookie，失效时自动重签。
 */
export class DpdnsReverseAdapter extends BaseAdapter {
  private readonly config: DpdnsAuthConfig;

  constructor(config: DpdnsAuthConfig) {
    super();
    this.config = config;
  }

  /**
   * 验证账号可用：有通行密钥则换签；只有旧版 rememberToken（隐藏字段）时先用它验证。
   * 这样升级后老账号不必立刻补凭据，直到旧会话自然失效才提示补充通行密钥。
   */
  async check(): Promise<boolean> {
    const hasLegacySession = Boolean(resolveSessionJar(this.config).get('remember_token'));
    if (!this.config.passkey && !hasLegacySession) {
      this.error = '未配置通行密钥（旧版会话凭证也未提供）';
      return false;
    }
    try {
      const valid = await validateCredentials(this.config);
      if (!valid) {
        this.error = this.error || (this.config.passkey
          ? '通行密钥无效或换签失败'
          : '旧会话已失效，请补充通行密钥');
      }
      return valid;
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  /**
   * 域名列表：本地切片分页。
   *
   * 上游接口一次返回全部域名、不支持分页参数；这里必须按 page/pageSize 切片，
   * 否则 domainSyncJob 的「本页条数 < pageSize 才结束」会永远为假（见 domainSyncJob.ts:170），
   * 域名数 ≥ pageSize 时形成无限翻页。
   *
   * 失败时把原因写进 this.error 并返回空列表：调用方（domainSyncJob）据此跳过同步，
   * 不会把「拉取失败」误判成「账号下没有域名」。
   */
  async getDomainList(keyword?: string, page = 1, pageSize = 100): Promise<PageResult<DomainInfo>> {
    this.clearError();
    try {
      const domains = await listAllDomains(this.config);
      const all: DomainInfo[] = domains.map((d) => ({
        Domain: d.domain,
        ThirdId: d.domain,
        ExpiresAt: parseDpdnsDate(d.expiry_date),
      }));

      const term = keyword?.trim().toLowerCase();
      const filtered = term ? all.filter((d) => d.Domain.toLowerCase().includes(term)) : all;

      const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
      const safeSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 100;
      const start = (safePage - 1) * safeSize;
      const list = filtered.slice(start, start + safeSize);

      log.sub('API').tag('SUCCESS').info('Fetched dpdns domains', {
        total: filtered.length,
        page: safePage,
        pageSize: safeSize,
        returned: list.length,
      });
      return { total: filtered.length, list };
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : String(e);
      log.sub('API').tag('FAILED').error('Failed to fetch domain list', { error: this.error });
      return { total: 0, list: [] };
    }
  }

  async getDomainRecords(): Promise<PageResult<DnsRecord>> {
    this.error = '该提供商不支持 DNS 记录管理（仅支持域名续期）';
    return { total: 0, list: [] };
  }

  async getDomainRecordInfo(): Promise<DnsRecord | null> {
    return null;
  }

  async addDomainRecord(): Promise<string | null> {
    return null;
  }

  async updateDomainRecord(): Promise<boolean> {
    return false;
  }

  async deleteDomainRecord(): Promise<boolean> {
    return false;
  }

  async setDomainRecordStatus(): Promise<boolean> {
    return false;
  }

  async getRecordLines(): Promise<Array<{ id: string; name: string }>> {
    // 反向代理只支持默认线路（builtin），显式声明而不是返回空数组
    return [{ id: DEFAULT_LINE, name: '默认' }];
  }

  async getMinTTL(): Promise<number> {
    return 600;
  }

  async addDomain(): Promise<boolean> {
    return false;
  }
}
