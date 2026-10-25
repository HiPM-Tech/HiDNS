import crypto from 'node:crypto';
import { DnsAdapter, DnsRecord, DomainInfo, PageResult } from '../DnsInterface';
import {
  Dict,
  buildCanonicalQuery,
  hmacSignSha1,
  requestJson,
} from './http';
import { createLogger } from '../../logger';

const log = createLogger('DNS').sub('Provider').sub('Common');

export type { Dict };

/**
 * 创建记录后回查真实 RecordId。
 *
 * 部分上游创建接口不返回记录 ID（PowerDNS 的 rrset replace、宝塔批量 create 等），
 * 历史实现用字面量 'success' 充当 ID，导致后续 update/delete 指向不存在的记录。
 * 这里按 name+type 回查，匹配不到返回 null（调用方按失败处理），绝不编造。
 */
export async function resolveCreatedRecordId(
  adapter: Pick<DnsAdapter, 'getDomainRecords'>,
  name: string,
  type: string,
): Promise<string | null> {
  try {
    const result = await adapter.getDomainRecords(1, 100);
    const wantedName = normalizeRrName(name);
    const wantedType = type.toUpperCase();
    const match = (result.list ?? []).find(
      (record) => normalizeRrName(record.Name) === wantedName && String(record.Type).toUpperCase() === wantedType,
    );
    return safeString(match?.RecordId) || null;
  } catch {
    return null;
  }
}

/**
 * 线路归一化（唯一执行点）。
 *
 * 规则（2.3.1 起）：
 * - 未指定（undefined/空串）→ 提供商的 defaultLine（每家适配器必须显式声明）；
 * - 历史哨兵 '0'：只有默认线路本身就是 '0' 时才保留，否则回落 defaultLine（华为云等）；
 * - 其它值原样透传，由上游校验。
 */
/**
 * 严格解析上游要求的数字记录 ID。
 * 历史实现用 toNumber(recordId, 0)，非法 ID 会静默落到「0 号记录」。
 */
export function requireNumericRecordId(recordId: string): number {
  const n = Number(recordId);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`非法记录 ID：${recordId || '(空)'}`);
  }
  return n;
}

/** 解析 powerdns 这类「rrsetId_recordId」复合 ID；任一段非法直接报错 */
export function parseCompositeRecordId(recordId: string, separator = '_'): { rrsetId: number; recordId: number } {
  const parts = String(recordId).split(separator);
  if (parts.length !== 2) throw new Error(`非法复合记录 ID：${recordId || '(空)'}`);
  const [rrsetRaw, recordRaw] = parts;
  const rrsetId = Number(rrsetRaw);
  const recId = Number(recordRaw);
  if (!Number.isInteger(rrsetId) || rrsetId < 0 || !Number.isInteger(recId) || recId < 0) {
    throw new Error(`非法复合记录 ID：${recordId}`);
  }
  return { rrsetId, recordId: recId };
}

export function resolveProviderLine(line: string | undefined, defaultLine: string): string {
  const trimmed = typeof line === 'string' ? line.trim() : '';
  if (!trimmed) return defaultLine;
  if (trimmed === '0' && defaultLine !== '0') return defaultLine;
  return trimmed;
}

export function safeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function toRecordStatus(value: unknown): number {
  const normalized = safeString(value).toUpperCase();
  return normalized === 'DISABLE' || normalized === 'DISABLED' ? 0 : 1;
}

export function normalizeRrName(value: string): string {
  const trimmed = safeString(value);
  return trimmed || '@';
}

export function sha256Hex(payload: string): string {
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

export function hmacSha256Hex(key: Buffer | string, data: string): string {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function isSrv(type: string): boolean {
  return safeString(type).toUpperCase() === 'SRV';
}

export function parseSrvValue(value: string): { port?: number; target?: string } {
  const parts = safeString(value).split(/\s+/).filter(Boolean);
  if (parts.length < 2) return {};
  const port = Number(parts[0]);
  if (!Number.isFinite(port)) return {};
  return { port, target: parts.slice(1).join(' ') };
}

export function buildSrvValue(port: unknown, target: unknown, fallback: unknown): string {
  const p = toNumber(port, NaN);
  const t = safeString(target);
  if (Number.isFinite(p) && t) return `${p} ${t}`;
  return safeString(fallback);
}

/**
 * 通用 domainId 解析函数
 * 当 config.domainId 未设置时，尝试通过域名搜索获取
 */
export async function resolveDomainIdHelper(
  config: { domainId?: string; zoneId?: string; domain?: string },
  getDomainList: (keyword?: string, page?: number, pageSize?: number) => Promise<PageResult<DomainInfo>>,
  providerName: string
): Promise<string | null> {
  // Support both domainId and zoneId fields
  // Priority: zoneId > domainId (zoneId is the actual provider's zone/region ID)
  if (config.zoneId) {
    return config.zoneId;
  }
  if (config.domainId) {
    return config.domainId;
  }

  if (!config.domain) {
    return null;
  }

  try {
    log.sub(providerName).debug(`Resolving domainId for domain: ${config.domain}`);
    const result = await getDomainList(config.domain, 1, 1);
    if (result.list.length > 0) {
      const domainId = result.list[0].ThirdId;
      log.sub(providerName).debug(`Resolved domainId: ${domainId} for domain: ${config.domain}`);
      // 缓存 domainId 避免重复查询
      config.domainId = domainId;
      return domainId;
    } else {
      log.sub(providerName).warn(`No domain found for: ${config.domain}. Available domains will be listed.`);
      // 尝试列出所有域名帮助调试
      const allDomains = await getDomainList(undefined, 1, 10);
      if (allDomains.list.length > 0) {
        log.sub(providerName).warn('Available domains', { domains: allDomains.list.map(d => d.Domain).join(', ') });
      }
    }
  } catch (error) {
    log.sub(providerName).error(`Failed to resolve domainId for domain: ${config.domain}`, { error });
  }

  return null;
}

export abstract class BaseAdapter implements DnsAdapter {
  protected error = '';

  getError(): string {
    return this.error;
  }

  /** 清空上一次调用的错误：读接口用它区分「本次失败」与「历史错误」 */
  clearError(): void {
    this.error = '';
  }

  abstract check(): Promise<boolean>;
  abstract getDomainList(keyword?: string, page?: number, pageSize?: number): Promise<PageResult<DomainInfo>>;
  abstract getDomainRecords(
    page?: number,
    pageSize?: number,
    keyword?: string,
    subdomain?: string,
    value?: string,
    type?: string,
    line?: string,
    status?: number
  ): Promise<PageResult<DnsRecord>>;
  abstract getDomainRecordInfo(recordId: string): Promise<DnsRecord | null>;
  abstract addDomainRecord(
    name: string,
    type: string,
    value: string,
    line?: string,
    ttl?: number,
    mx?: number,
    weight?: number,
    remark?: string
  ): Promise<string | null>;
  abstract updateDomainRecord(
    recordId: string,
    name: string,
    type: string,
    value: string,
    line?: string,
    ttl?: number,
    mx?: number,
    weight?: number,
    remark?: string
  ): Promise<boolean>;
  abstract deleteDomainRecord(recordId: string): Promise<boolean>;
  abstract setDomainRecordStatus(recordId: string, status: number): Promise<boolean>;
  abstract getRecordLines(): Promise<Array<{ id: string; name: string }>>;
  abstract getMinTTL(): Promise<number>;
  abstract addDomain(domain: string): Promise<boolean>;
}

export abstract class TokenAuthAdapter extends BaseAdapter {
  protected readonly token: string;

  constructor(config: Record<string, string>, tokenField = 'token') {
    super();
    this.token = safeString(config[tokenField]);
  }

  protected bearerAuth(headers: Record<string, string> = {}): Record<string, string> {
    return {
      ...headers,
      Authorization: `Bearer ${this.token}`,
    };
  }
}

export abstract class AliyunRpcAdapter extends BaseAdapter {
  protected readonly accessKeyId: string;
  protected readonly accessKeySecret: string;
  protected readonly useProxy: boolean;

  constructor(config: Record<string, string>) {
    super();
    this.accessKeyId = safeString(config.AccessKeyId);
    this.accessKeySecret = safeString(config.AccessKeySecret);
    this.useProxy = !!config.useProxy;
  }

  protected abstract endpoint(): string;
  protected version(): string {
    return '2015-01-09';
  }

  protected async rpcCall<T = Dict>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    const publicParams: Record<string, unknown> = {
      Action: action,
      Format: 'JSON',
      Version: this.version(),
      AccessKeyId: this.accessKeyId,
      SignatureMethod: 'HMAC-SHA1',
      Timestamp: new Date().toISOString(),
      SignatureVersion: '1.0',
      SignatureNonce: uuid(),
      ...params,
    };

    const canonicalized = buildCanonicalQuery(publicParams);
    const stringToSign = `GET&%2F&${encodeURIComponent(canonicalized)}`;
    const signature = hmacSignSha1(`${this.accessKeySecret}&`, stringToSign, 'base64');

    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(publicParams)) {
      if (v === undefined || v === null || v === '') continue;
      query.set(k, String(v));
    }
    query.set('Signature', signature);

    const url = `${this.endpoint()}?${query.toString()}`;
    log.sub('API').tag('REQUEST').debug('Provider request', { method: 'GET', url: url, params: undefined });
    const result = await requestJson<T>(url, {
      method: 'GET',
      parseError: (payload) => {
        const data = (payload ?? {}) as Dict;
        if (data.Code || data.Message) {
          log.sub('API').tag('ERROR').error('Provider error', data);
          return safeString(data.Message) || safeString(data.Code) || `Aliyun action ${action} failed`;
        }
        return undefined;
      },
      useProxy: this.useProxy,
      providerName: 'Aliyun',
    });
    log.sub('API').tag('RESPONSE').debug('Provider response', { status: 200, success: true, data: { action, hasData: result !== null } });
    return result;
  }
}

export abstract class TencentCloudAdapter extends BaseAdapter {
  protected readonly secretId: string;
  protected readonly secretKey: string;
  protected readonly useProxy: boolean;

  constructor(config: Record<string, string>) {
    super();
    this.secretId = safeString(config.SecretId);
    this.secretKey = safeString(config.SecretKey);
    this.useProxy = !!config.useProxy;
  }

  protected abstract service(): string;
  protected abstract endpoint(): string;
  protected abstract version(): string;

  protected async call<T = Dict>(action: string, payload: Dict = {}): Promise<T> {
    const host = this.endpoint();
    const method = 'POST';
    const canonicalUri = '/';
    const canonicalQueryString = '';
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const signedHeaders = 'content-type;host;x-tc-action';
    const canonicalHeaders =
      `content-type:application/json; charset=utf-8\n` +
      `host:${host}\n` +
      `x-tc-action:${action.toLowerCase()}\n`;

    const hashedRequestPayload = sha256Hex(body);
    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      hashedRequestPayload,
    ].join('\n');

    const credentialScope = `${date}/${this.service()}/tc3_request`;
    const stringToSign = [
      'TC3-HMAC-SHA256',
      String(timestamp),
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const secretDate = hmacSha256(`TC3${this.secretKey}`, date);
    const secretService = hmacSha256(secretDate, this.service());
    const secretSigning = hmacSha256(secretService, 'tc3_request');
    const signature = hmacSha256Hex(secretSigning, stringToSign);
    const authorization =
      `TC3-HMAC-SHA256 Credential=${this.secretId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const url = `https://${host}`;
    log.sub('API').tag('REQUEST').debug('Provider request', { method: 'POST', url: url, params: { action } });
    const data = await requestJson<Dict>(url, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json; charset=utf-8',
        Host: host,
        'X-TC-Action': action,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Version': this.version(),
      },
      body,
      useProxy: this.useProxy,
      providerName: 'TencentCloud',
    });

    const response = (data.Response ?? data) as Dict;
    const error = response.Error as Dict | undefined;
    if (error) {
      const code = safeString(error?.Code);
      const msg = safeString(error?.Message) || `TencentCloud action ${action} failed`;
      log.sub('API').tag('ERROR').error('Provider error', error);
      throw new Error(code ? `${code}: ${msg}` : msg);
    }
    log.sub('API').tag('RESPONSE').debug('Provider response', { status: 200, success: true, data: { action, hasData: response !== null } });
    return response as T;
  }
}

export class StubAdapter extends BaseAdapter {
  constructor(private readonly providerName: string) {
    super();
  }

  private err(): Error {
    return new Error(`${this.providerName}: Not implemented`);
  }

  async check(): Promise<boolean> { throw this.err(); }
  async getDomainList(): Promise<PageResult<DomainInfo>> { throw this.err(); }
  async getDomainRecords(): Promise<PageResult<DnsRecord>> { throw this.err(); }
  async getDomainRecordInfo(): Promise<DnsRecord | null> { throw this.err(); }
  async addDomainRecord(): Promise<string | null> { throw this.err(); }
  async updateDomainRecord(): Promise<boolean> { throw this.err(); }
  async deleteDomainRecord(): Promise<boolean> { throw this.err(); }
  async setDomainRecordStatus(): Promise<boolean> { throw this.err(); }
  async getRecordLines(): Promise<Array<{ id: string; name: string }>> { return [{ id: '0', name: '默认' }]; }
  async getMinTTL(): Promise<number> { return 600; }
  async addDomain(): Promise<boolean> { throw this.err(); }
}
