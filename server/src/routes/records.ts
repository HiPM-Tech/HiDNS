import { Router, Request, Response } from 'express';
import { promises as dnsPromises } from 'dns';
import { authMiddleware, requireTokenDomainPermission } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { createAdapter } from '../lib/dns/DnsHelper';
import { getProviderDefinitions } from '../lib/dns/providers/registry';
import { DnsAccount, Domain } from '../types';
import { type DnsRecord as AdapterRecord } from '../lib/dns/DnsInterface';
import type { RecordType } from '../lib/dns/record-types';
import { getDomainAccess } from './domains';
import { normalizeRole } from '../utils/roles';
import { logAuditOperation } from '../service/audit';
import { parseInteger, parsePagination, sendError, sendSuccess } from '../utils/http';
import { DomainOperations, DnsAccountOperations } from '../db/bal/business-adapter';
import { hasWorkflowSubscribers, publishRecordEvent } from '../workflow/publish';
import { findRecordMeta } from '../lib/dns/record-lookup';
import { createLogger } from '../lib/logger';
import { wsService } from '../service/websocket';
import { getDomainAudienceUserIds } from '../service/realtime-audience';
import { normalizeDomain, isValidDomain } from '../utils/dns';
import { normalizeProviderType } from '../lib/dns/providerAlias';
import { resolveLineInput } from '../service/record-line';
import { validateRecordValue, validateExtraField, getRecordTypeDef } from '../lib/dns/record-types';
import { getAvailableTemplates, getEmailTemplate, generatePreview } from '../lib/dns/emailTemplate';

const log = createLogger('HTTP').sub('Route').sub('Records');
const router = Router({ mergeParams: true });

// Create a separate router for email templates to avoid route conflicts with /:domainId/records
export const emailTemplatesRouter = Router();

function toApiRecord(r: AdapterRecord) {
  const cloudflare = r.Cloudflare ?? (r.Proxiable !== undefined
    ? { proxied: r.Line === '1', proxiable: r.Proxiable }
    : null);

  return {
    id: r.RecordId,
    name: r.Name,
    type: r.Type,
    value: r.Value,
    line: r.Line,
    ttl: r.TTL,
    mx: r.MX,
    weight: r.Weight,
    status: r.Status,
    proxiable: r.Proxiable ?? null,
    cloudflare,
    remark: r.Remark ?? null,
    updated_at: r.UpdateTime ?? null,
  };
}

function isValidRecordValue(type: string, value: string): string | true {
  const result = validateRecordValue(type, value);
  return result === null ? true : result;
}

const DYNAMIC_RECORD_TYPES_PROVIDERS = new Set(['hidns_v2']);

function providerCapability(accountType: string): { proxiable: boolean; status: boolean; remark: boolean; weight: boolean; redirect: boolean } | null {
  const def = getProviderDefinitions().find(
    (provider) => normalizeProviderType(provider.type) === normalizeProviderType(accountType),
  );
  if (!def?.capabilities.dns) return null;
  return {
    proxiable: def.capabilities.dns.proxiable,
    status: def.capabilities.dns.status,
    remark: def.capabilities.dns.remark,
    weight: def.capabilities.dns.weight,
    redirect: Boolean(def.capabilities.redirect),
  };
}

/**
 * 重定向入参解析。
 * 规则：提供商未声明 capabilities.redirect → 一律忽略（不报错、不落库）；
 * 已声明但 URL 非法 → 400；合法 → 交给适配器的 setRecordRedirect。
 */
export function resolveRedirectTarget(
  redirectSupported: boolean,
  redirect: unknown,
): { target?: string; error?: string; ignored: boolean } {
  if (redirect === undefined || redirect === null || redirect === '') {
    return { ignored: false };
  }
  if (!redirectSupported) return { ignored: true };
  if (typeof redirect !== 'string') return { ignored: false, error: 'redirect 必须是字符串 URL' };
  const target = redirect.trim();
  if (target.length > 1024) return { ignored: false, error: 'redirect 最长 1024 字符' };
  try {
    const parsed = new URL(target);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { ignored: false, error: 'redirect 只支持 http/https URL' };
    }
  } catch {
    return { ignored: false, error: 'redirect 不是合法 URL' };
  }
  return { ignored: false, target };
}

function providerSupportsProxy(accountType: string): boolean {
  const def = getProviderDefinitions().find(
    (provider) => normalizeProviderType(provider.type) === normalizeProviderType(accountType),
  );
  return Boolean(def?.capabilities.dns?.proxiable);
}

/** 代理开关是能力位，不是所有提供商都支持；不支持的提供商收到 proxied=true 应直接拒绝 */
export function proxyCapabilityError(accountType: string, proxied: boolean | undefined): string | null {
  if (proxied !== true) return null;
  if (providerSupportsProxy(accountType)) return null;
  return `提供商 "${accountType}" 不支持代理开关（proxied）`;
}

function isTypeSupportedByProvider(accountType: string, recordType: string): boolean {
  if (DYNAMIC_RECORD_TYPES_PROVIDERS.has(accountType)) return true;
  const def = getProviderDefinitions().find(p => p.type === accountType);
  if (!def || !def.capabilities.dns) return true;
  return def.capabilities.dns.recordTypes.includes(recordType as RecordType);
}

function getSubdomain(fullName: string, domainName: string): string {
  // Use IDN-aware normalization
  const full = normalizeDomain(fullName);
  const domain = normalizeDomain(domainName);
  if (full === domain) return '@';
  if (full.endsWith('.' + domain)) return full.slice(0, -(domain.length + 1));
  return full;
}

function canWriteSubdomain(writeSubs: string[] | null, fullName: string, domainName: string): boolean {
  if (writeSubs === null) return true;
  const sub = getSubdomain(fullName, domainName);
  return writeSubs.includes(sub);
}

/**
 * 记录类事件的 payload 形状：type + data。
 * data 用 unknown 是因为各事件字段不同（record_created 带整条记录，其余只带 id），
 * 本辅助函数只负责投递范围，不解析也不改写 payload 结构。
 */
interface RecordRealtimeMessage {
  type: string;
  data: unknown;
}

/**
 * 解析记录类事件的定向推送。
 *
 * 为什么不再用 wsService.broadcast：record_* 的 payload 里带 domainId / recordId /
 * host / 记录值，全局广播会把他人域名的解析结构与记录内容推给所有在线客户端，
 * 等于把「能读该域名的用户」之外的登录用户也纳入了可见范围。
 *
 * 收件人口径与同文件读接口一致：GET /domains/:domainId/records（本文件 getDomainAccess
 * 的 canRead 判定，见 records.ts 列表处理器），由 getDomainAudienceUserIds 落实
 * （该函数逐条对齐 routes/domains.ts 的 resolveDomainAccess）。
 *
 * fail-closed：算不出收件人（域名被删、账号被禁用、查询失败）时跳过投递并记 warn，
 * 绝不回退成全局广播——回退等于把刚堵上的口子重新打开。
 */
async function pushRecordEvent(domainId: number, message: RecordRealtimeMessage): Promise<void> {
  try {
    const audience = await getDomainAudienceUserIds(domainId);
    if (audience.length === 0) {
      log.warn('No audience for record event, skipped', { domainId, type: message.type });
      return;
    }
    wsService.broadcastToUsers(audience, message);
  } catch (error) {
    log.error('Failed to push record event', { domainId, type: message.type, error });
  }
}

async function getAdapterForDomain(domain: Domain) {
  log.debug('Getting adapter for domain', { domainId: domain.id, domainName: domain.name, accountId: domain.account_id, thirdId: domain.third_id });
  const account = await DnsAccountOperations.getById(domain.account_id) as DnsAccount | undefined;
  if (!account) {
    log.error('Account not found', { accountId: domain.account_id });
    throw new Error('Account not found');
  }
  log.debug('Found account', { accountType: account.type, accountName: account.name });
  // MySQL JSON type returns object directly, SQLite/PostgreSQL returns string
  const cfg = typeof account.config === 'string' ? JSON.parse(account.config) as Record<string, string> : account.config as Record<string, string>;

  // For HiDNS provider, use third_id (remote domain ID) as domainId
  // For other providers, use local domain.id
  const isHiDNS = account.type === 'hidns';
  const domainId = isHiDNS && domain.third_id ? domain.third_id : String(domain.id);

  log.debug('Creating adapter', { type: account.type, domain: domain.name, thirdId: domain.third_id, localDomainId: domain.id, effectiveDomainId: domainId, isHiDNS });
  const adapter = createAdapter(account.type, cfg, domain.name, domain.third_id, domainId);
  log.debug('Adapter created');
  return adapter;
}

async function updateDomainRecordCount(domainId: number, count: number): Promise<void> {
  await DomainOperations.updateRecordCount(domainId, count);
}

/**
 * @swagger
 * /api/domains/{domainId}/records:
 *   get:
 *     summary: List DNS records for a domain
 *     tags: [Records]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: domainId
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: pageSize
 *         schema:
 *           type: integer
 *       - in: query
 *         name: keyword
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of DNS records
 */
router.get('/', authMiddleware, requireTokenDomainPermission('domainId'), asyncHandler(async (req: Request, res: Response, next) => {
  log.debug('=== GET /records route entered ===', { domainId: req.params.domainId, path: req.path, originalUrl: req.originalUrl });

  // 检查是否有 domainId 参数，如果没有则交给下一个路由处理（如 email-templates）
  if (!req.params.domainId) {
    log.debug('No domainId parameter, passing to next route');
    return next();
  }

  const domainId = parseInteger(req.params.domainId) ?? 0;
  log.debug('Parsed domainId', { domainId });
  const access = await getDomainAccess(domainId, req.user!.userId, normalizeRole(req.user!.role));
  log.debug('Got domain access', { hasDomain: !!access.domain, canRead: access.canRead });
  if (!access.domain || !access.canRead) {
    sendError(res, 'Domain not found', 404);
    return;
  }
  const { keyword, subdomain, value, type, line, status } = req.query as Record<string, string>;
  // 分页统一口径：默认 20、上限 100（历史实现默认 100 且不设上限，会把整域记录一次性拉给适配器）
  const { page, pageSize } = parsePagination(req.query, { defaultPageSize: 20, maxPageSize: 100 });
  try {
    log.debug('Fetching records', { domainId: access.domain.id, page, pageSize, keyword, subdomain, value, type, line, status });
    const dnsAdapter = await getAdapterForDomain(access.domain);
    log.debug('Got adapter, calling getDomainRecords');
    const result = await dnsAdapter.getDomainRecords(
      page, pageSize, keyword, subdomain, value, type, line,
      status !== undefined ? parseInt(status) : undefined
    );
    log.debug('Got records result', { total: result.total, count: result.list.length });
    // 适配器读失败会折叠成 { total: 0, list: [] }，与"真的 0 条"同形；
    // 只在拿到非空结果时回写计数，避免一次上游抖动把 record_count 永久写成 0。
    if (result.total > 0) {
      await updateDomainRecordCount(access.domain.id, result.total);
    }
    sendSuccess(res, { total: result.total, list: result.list.map(toApiRecord) });
  } catch (e) {
    log.error('Error fetching records', { error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
    sendError(res, e instanceof Error ? e.message : String(e));
  }
}));

/**
 * @swagger
 * /api/domains/{domainId}/records/export/zone:
 *   get:
 *     summary: Export DNS records in BIND zone file format (batch fetching)
 *     tags: [Records]
 *     security:
 *       - bearerAuth: []
 */
router.get('/export/zone', authMiddleware, requireTokenDomainPermission('domainId'), asyncHandler(async (req: Request, res: Response) => {
  const domainId = parseInteger(req.params.domainId) ?? 0;
  const access = await getDomainAccess(domainId, req.user!.userId, normalizeRole(req.user!.role));
  if (!access.domain || !access.canRead) {
    sendError(res, 'Domain not found', 404);
    return;
  }

  try {
    const dnsAdapter = await getAdapterForDomain(access.domain);
    const domainName = access.domain.name;
    const nameFormat = String(req.query.nameFormat || 'relative');
    const useFullName = nameFormat === 'full';

    // 分批获取全量解析记录，避免瞬时爆炸
    const batchSize = 100;
    let page = 1;
    const allRecords: AdapterRecord[] = [];
    let total = 0;

    do {
      try {
        const result = await dnsAdapter.getDomainRecords(page, batchSize);
        if (page === 1) total = result.total;
        // 当页无数据时，说明已获取完所有记录（DNSPod 等提供商在页数超出时返回 ResourceNotFound.NoDataOfRecord）
        if (result.list.length === 0) break;
        allRecords.push(...result.list);
      } catch (err: unknown) {
        // 部分提供商（如 DNSPod）在记录为空时返回 ResourceNotFound.NoDataOfRecord
        // 直接视为空记录集
        if (page === 1) {
          break;
        }
        throw err;
      }
      page++;
      // 保护：最多 100 批（50000 条记录）
      if (page > 100) break;
    } while (allRecords.length < total);

    // 生成时间戳（Asia/Shanghai 时区）
    const now = new Date();
    const ts = Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(now).replace(/\//g, '-');

    const dotDomain = domainName.endsWith('.') ? domainName : `${domainName}.`;

    // 按类型分组（仅启用记录）
    const enabled = allRecords.filter(r => r.Status === 1);
    const typeOrder = ['A', 'AAAA', 'CAA', 'CNAME', 'MX', 'NS', 'SPF', 'SRV', 'TXT', 'HTTPS', 'SVCB', 'CERT', 'SSHFP', 'TLSA', 'NAPTR', 'LOC', 'SMIMEA', 'URI', 'DNAME'];
    const grouped: Record<string, AdapterRecord[]> = {};
    for (const r of enabled) {
      const t = r.Type.toUpperCase();
      if (!grouped[t]) grouped[t] = [];
      grouped[t].push(r);
    }

    // 构建 HiDNS 地址
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const repoUrl = 'https://github.com/HiPM-Tech/HiDNS';

    // 通过 DNS 查询获取真实 SOA 记录
    let soaLine = `${dotDomain}  600     IN      SOA     ${dotDomain} admin.${dotDomain} ${Math.floor(now.getTime() / 1000)} 3600 180 1209600 180`;
    try {
      const soa = await dnsPromises.resolveSoa(domainName);
      const hostmaster = soa.hostmaster.endsWith('.') ? soa.hostmaster : `${soa.hostmaster}.`;
      const nsname = soa.nsname.endsWith('.') ? soa.nsname : `${soa.nsname}.`;
      soaLine = `${dotDomain}  ${soa.minttl}     IN      SOA     ${nsname} ${hostmaster} ${soa.serial} ${soa.refresh} ${soa.retry} ${soa.expire} ${soa.minttl}`;
    } catch {
      // DNS 查询失败时使用合成 SOA
    }

    // 生成 zone 文件头部
    const lines: string[] = [
      `; Domain: ${dotDomain}`,
      `; Exported at:${ts} (Asia/Shanghai)`,
      `;`,
      `;  ██╗  ██╗██╗██████╗ ███╗   ██╗███████╗`,
      `;  ██║  ██║██║██╔══██╗████╗  ██║██╔════╝`,
      `;  ███████║██║██║  ██║██╔██╗ ██║███████╗`,
      `;  ██╔══██║██║██║  ██║██║╚██╗██║╚════██║`,
      `;  ██║  ██║██║██████╔╝██║ ╚████║███████║`,
      `;  ╚═╝  ╚═╝╚═╝╚═════╝ ╚═╝  ╚═══╝╚══════╝`,
      `;`,
      `;  ${baseUrl}`,
      `;  ${repoUrl}`,
      `;`,
      `; This file is intended for use for informational and archival`,
      `; purposes ONLY and MUST be edited before used on a production`,
      `; DNS server.`,
      `;`,
      `; For further information, please consult the BIND documentation`,
      `; located on the following website:`,
      `;     \`http://www.isc.org/\``,
      `;`,
      `; And RFC 1035:`,
      `;    \`http://www.ietf.org/rfc/rfc1035.txt\``,
      `;`,
      `; Use at your own risk.`,
      `;`,
      ``,
      `$ORIGIN ${dotDomain}`,
      ``,
      `; SOA record`,
      soaLine,
      ``,
    ];

    // 输出各类型记录
    const writeRecord = (r: AdapterRecord) => {
      const name = useFullName
        ? (r.Name === '@' ? dotDomain : `${r.Name}.${dotDomain}`)
        : r.Name; // @ 代表 $ORIGIN，其它保持相对名称
      const ttl = r.TTL ?? 600;
      const remark = r.Remark ? `; ${r.Remark}` : '';

      if (r.Type.toUpperCase() === 'MX' && r.MX !== undefined) {
        return `${name}\t${ttl}\tIN\t${r.Type}\t${r.MX}\t${r.Value}${remark}`;
      }
      if (r.Type.toUpperCase() === 'SRV') {
        // SRV value format: priority weight port target
        return `${name}\t${ttl}\tIN\t${r.Type}\t${r.Value}${remark}`;
      }
      if (r.Type.toUpperCase() === 'CAA') {
        return `${name}\t${ttl}\tIN\t${r.Type}\t${r.Value}${remark}`;
      }
      return `${name}\t${ttl}\tIN\t${r.Type}\t${r.Value}${remark}`;
    };

    for (const type of typeOrder) {
      const records = grouped[type];
      if (!records || records.length === 0) continue;
      lines.push(`; ${type} records`);
      for (const r of records) {
        lines.push(writeRecord(r));
      }
      lines.push('');
    }

    // 输出剩余未知类型的记录
    const knownTypes = new Set(typeOrder);
    const unknownTypes = Object.keys(grouped).filter(t => !knownTypes.has(t));
    for (const type of unknownTypes) {
      const records = grouped[type];
      if (records.length === 0) continue;
      lines.push(`; ${type} records`);
      for (const r of records) {
        lines.push(writeRecord(r));
      }
      lines.push('');
    }

    sendSuccess(res, {
      content: lines.join('\n'),
      filename: `${domainName}.zone`,
    });
  } catch (e) {
    sendError(res, e instanceof Error ? e.message : String(e));
  }
}));

/**
 * @swagger
 * /api/domains/{domainId}/records/{recordId}:
 *   get:
 *     summary: Get a DNS record detail
 *     tags: [Records]
 *     security:
 *       - bearerAuth: []
 */
router.get('/:recordId', authMiddleware, requireTokenDomainPermission('domainId'), asyncHandler(async (req: Request, res: Response) => {
  const domainId = parseInteger(req.params.domainId) ?? 0;
  const recordId = req.params.recordId;
  const access = await getDomainAccess(domainId, req.user!.userId, normalizeRole(req.user!.role));
  if (!access.domain || !access.canRead) {
    sendError(res, 'Domain not found', 404);
    return;
  }
  try {
    const dnsAdapter = await getAdapterForDomain(access.domain);
    let record = await dnsAdapter.getDomainRecordInfo(recordId);
    if (!record) {
      const result = await dnsAdapter.getDomainRecords(1, 1000);
      record = result.list.find((item) => item.RecordId === recordId) ?? null;
    }
    if (!record) {
      sendError(res, 'Record not found', 404);
      return;
    }
    sendSuccess(res, toApiRecord(record));
  } catch (e) {
    sendError(res, e instanceof Error ? e.message : String(e));
  }
}));

/**
 * @swagger
 * /api/domains/{domainId}/records:
 *   post:
 *     summary: Add a DNS record
 *     tags: [Records]
 *     security:
 *       - bearerAuth: []
 */

/**
 * 单条记录的服务端校验（此前完全没有，64 字符标签 / name=" " / ttl=-1 / mx=99999 都会被发往上游）。
 * 返回错误文案；null 表示通过。
 */
export function validateRecordInput(input: {
  name?: string; type?: string; value?: string;
  ttl?: number; mx?: number; weight?: number;
}): string | null {
  const name = (input.name ?? '').trim();
  if (!name) return '记录名不能为空';
  if (name.includes('..')) return '记录名不能包含连续的点';
  if (name !== '@' && name !== '*') {
    // 单标签按 Punycode 计长（63 字符限制）：中文标签 UTF-16 长度会低估
    const labels = normalizeDomain(name).split('.');
    for (const label of labels) {
      if (label.length === 0) return '记录名包含空标签';
      if (label.length > 63) return '记录名单个标签超过 63 个字符';
      if (!/^[a-z0-9_*\-]+$/i.test(label)) return '记录名包含非法字符: ' + label;
      if (label.startsWith('-') || label.endsWith('-')) return '记录名标签不能以 - 开头或结尾';
    }
    if (normalizeDomain(name).length > 253) return '记录名超过 253 个字符';
  }
  if (input.ttl !== undefined && input.ttl !== null) {
    if (!Number.isInteger(input.ttl) || input.ttl < 1) return 'TTL 必须是正整数';
    if (input.ttl > 2147483647) return 'TTL 超出范围';
  }
  for (const [field, value] of [['mx', input.mx], ['weight', input.weight]] as const) {
    if (value === undefined || value === null) continue;
    if (!Number.isInteger(value) || value < 0 || value > 65535) return field.toUpperCase() + ' 必须是 0-65535 的整数';
  }
  return null;
}

router.post('/', authMiddleware, requireTokenDomainPermission('domainId'), asyncHandler(async (req: Request, res: Response) => {
  const domainId = parseInteger(req.params.domainId) ?? 0;
  const access = await getDomainAccess(domainId, req.user!.userId, normalizeRole(req.user!.role));
  if (!access.domain || !access.canRead) {
    sendError(res, 'Domain not found', 404);
    return;
  }
  if (!access.canWrite) {
    sendError(res, 'Permission denied', 403);
    return;
  }
  const { name, type, value, line, proxied, ttl, mx, weight, remark, redirect, cloudflare, aliyunesa } = req.body as {
    name: string; type: string; value: string; line?: string; proxied?: boolean; redirect?: string;
    ttl?: number; mx?: number; weight?: number; remark?: string;
    cloudflare?: { proxied?: boolean };
    aliyunesa?: { proxied?: boolean };
  };
  if (!name || !type || !value) {
    sendError(res, 'name, type, and value are required');
    return;
  }
  const inputError = validateRecordInput({ name, type, value, ttl, mx, weight });
  if (inputError) {
    sendError(res, inputError);
    return;
  }
  if (!canWriteSubdomain(access.writeSubs, name, access.domain.name)) {
    sendError(res, 'Permission denied for subdomain', 403);
    return;
  }
  {
    const err = isValidRecordValue(type, value);
    if (err !== true) { sendError(res, err); return; }
  }
  const account = await DnsAccountOperations.getById(access.domain.account_id) as DnsAccount | undefined;
  if (account && !isTypeSupportedByProvider(account.type, type)) {
    sendError(res, `Record type "${type}" is not supported by provider "${account.type}"`);
    return;
  }
  if (account) {
    const proxyError = proxyCapabilityError(account.type, proxied);
    if (proxyError) { sendError(res, proxyError); return; }
  }
  try {
    const dnsAdapter = await getAdapterForDomain(access.domain);
    // line 语义收敛：line 只表示线路；CF/ESA 的代理开关走 proxied（兼容旧 cloudflare/aliyunesa.proxied 与 line:'0'/'1'）
    const { line: effectiveLine } = resolveLineInput(normalizeProviderType(account?.type ?? ''), {
      line,
      proxied,
      legacyProxied: cloudflare?.proxied ?? aliyunesa?.proxied,
    });
    const capability = account ? providerCapability(account.type) : null;
    const redirectResult = resolveRedirectTarget(Boolean(capability?.redirect), redirect);
    if (redirectResult.error) { sendError(res, redirectResult.error); return; }
    if (redirectResult.ignored) {
      log.debug('redirect ignored: provider did not declare capabilities.redirect', { providerType: account?.type });
    }
    const remarkSupported = capability ? capability.remark !== false : true;
    // weight 能力位同样要有执行点：不支持的提供商不传权重，避免上游忽略/报错
    const weightSupported = capability ? capability.weight !== false : true;
    const recordId = await dnsAdapter.addDomainRecord(name, type, value, effectiveLine, ttl, mx, weightSupported ? weight : undefined, remarkSupported ? remark : undefined);
    if (!recordId) {
      sendError(res, 'Failed to add record');
      return;
    }
    if (redirectResult.target) {
      if (typeof dnsAdapter.setRecordRedirect !== 'function') {
        sendError(res, '该提供商声明支持重定向，但适配器尚未实现', 501);
        return;
      }
      const redirectOk = await dnsAdapter.setRecordRedirect(recordId, redirectResult.target);
      if (!redirectOk) { sendError(res, '设置记录重定向失败'); return; }
    }
    await logAuditOperation(req.user!.userId, 'add_record', access.domain.name, { name, type, value, redirect: redirectResult.target }, req);

    // 获取新创建的记录数据用于 WebSocket 推送
    const newRecord = await dnsAdapter.getDomainRecordInfo(recordId);

    // 发布到工作流事件总线（无订阅者时零成本；非 A/AAAA 自动丢弃）
    publishRecordEvent({
      action: 'created',
      domain: { id: domainId, name: access.domain.name },
      record: { id: recordId, name, type, value },
      actor: { userId: req.user!.userId, source: 'ui' },
    });

    // 推送 WebSocket 消息：只推给能读到该域名的用户
    // （口径同 GET /domains/:domainId/records 的 canRead，见 getDomainAccess 判定）
    await pushRecordEvent(access.domain.id, {
      type: 'record_created',
      data: {
        recordId,
        domainId,
        host: name,
        type,
        record: newRecord,
      },
    });

    sendSuccess(res, { id: recordId });
  } catch (e) {
    sendError(res, e instanceof Error ? e.message : String(e));
  }
}));

/**
 * @swagger
 * /api/domains/email-templates:
 *   get:
 *     summary: Get available email templates
 *     tags: [Records]
 *     security:
 *       - bearerAuth: []
 */
emailTemplatesRouter.get('/', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const templates = getAvailableTemplates();
  sendSuccess(res, { templates });
}));

/**
 * @swagger
 * /api/domains/email-templates/{templateId}:
 *   get:
 *     summary: Get specific email template details
 *     tags: [Records]
 *     security:
 *       - bearerAuth: []
 */
emailTemplatesRouter.get('/:templateId', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const templateId = req.params.templateId;

  const template = getEmailTemplate(templateId);
  if (!template) {
    sendError(res, 'Template not found', 404);
    return;
  }

  sendSuccess(res, { template });
}));

/**
 * @swagger
 * /api/domains/email-templates/{templateId}/preview:
 *   get:
 *     summary: Get email template preview for a domain
 *     tags: [Records]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: templateId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: domain
 *         required: true
 *         schema:
 *           type: string
 */
emailTemplatesRouter.get('/:templateId/preview', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const templateId = req.params.templateId;
  const { domain } = req.query;

  if (!domain || typeof domain !== 'string') {
    sendError(res, 'Domain parameter is required', 400);
    return;
  }

  const template = getEmailTemplate(templateId);
  if (!template) {
    sendError(res, 'Template not found', 404);
    return;
  }

  const preview = generatePreview(templateId, domain);
  sendSuccess(res, { preview });
}));

/** 单次批量导入的条数上限（docs/api.md 同步） */
export const MAX_BATCH_RECORDS = 100;

/**
 * 批量条数校验：返回错误文案（null = 通过）。
 * 抽成纯函数是为了能直接测边界（0 / 1 / 100 / 101），不必起 DB 与鉴权链路。
 */
export function assertBatchSize(count: number): string | null {
  if (count === 0) return 'records array is required';
  if (count > MAX_BATCH_RECORDS) return 'At most ' + MAX_BATCH_RECORDS + ' records per batch';
  return null;
}

router.post('/batch', authMiddleware, requireTokenDomainPermission('domainId'), asyncHandler(async (req: Request, res: Response) => {
  const domainId = parseInteger(req.params.domainId) ?? 0;
  const access = await getDomainAccess(domainId, req.user!.userId, normalizeRole(req.user!.role));
  if (!access.domain || !access.canRead) {
    sendError(res, 'Domain not found', 404);
    return;
  }
  if (!access.canWrite) {
    sendError(res, 'Permission denied', 403);
    return;
  }

  const records = req.body.records as Array<{
    name: string; type: string; value: string; line?: string; proxied?: boolean;
    ttl?: number; mx?: number; weight?: number; remark?: string;
  }>;

  if (!Array.isArray(records)) {
    sendError(res, 'records array is required');
    return;
  }

  // 上限：单次批量最多 100 条（与 docs/api.md 一致）。无上限时一次请求可以打爆
  // 上游提供商的配额，也会让超时/部分失败的处理失去意义。
  const batchError = assertBatchSize(records.length);
  if (batchError) {
    sendError(res, batchError, records.length > MAX_BATCH_RECORDS ? 422 : 400);
    return;
  }

  for (const r of records) {
    if (!r || typeof r !== 'object') {
      sendError(res, 'records 里的每一项都必须是对象', 400);
      return;
    }
    if (!r.name || !r.type || !r.value) {
      sendError(res, 'name, type, and value are required for all records');
      return;
    }
    const batchInputError = validateRecordInput({ name: r.name, type: r.type, value: r.value, ttl: r.ttl, mx: r.mx, weight: r.weight });
    if (batchInputError) {
      sendError(res, batchInputError + '（' + (r.name || '?') + '）');
      return;
    }
    if (!canWriteSubdomain(access.writeSubs, r.name, access.domain.name)) {
      sendError(res, `Permission denied for subdomain: ${r.name}`);
      return;
    }
    {
      const err = isValidRecordValue(r.type, r.value);
      if (err !== true) { sendError(res, err); return; }
    }
  }

  const account = await DnsAccountOperations.getById(access.domain.account_id) as DnsAccount | undefined;
  if (account) {
    const unsupported = records.filter(r => !isTypeSupportedByProvider(account.type, r.type));
    if (unsupported.length > 0) {
      const types = [...new Set(unsupported.map(r => r.type))].join(', ');
      sendError(res, `Record types not supported by provider "${account.type}": ${types}`);
      return;
    }
  }

  const dnsAdapter = await getAdapterForDomain(access.domain);
  const addedIds: string[] = [];
  const errors: string[] = [];
  // 逐条结果：下标与请求里的 records 一一对应，客户端据此标出哪一行失败
  const results: Array<{ line: number; ok: boolean; recordId?: string; error?: string }> = [];

  for (const [index, r] of records.entries()) {
    try {
      // 与单条创建共用同一个归一化点：line 只表示线路，代理开关走 proxied
      const { line: effectiveLine } = resolveLineInput(normalizeProviderType(account?.type ?? ''), {
        line: r.line,
        proxied: r.proxied,
      });
      const recordId = await dnsAdapter.addDomainRecord(r.name, r.type, r.value, effectiveLine, r.ttl, r.mx, r.weight, r.remark);
      if (recordId) {
        addedIds.push(recordId);
        results.push({ line: index + 1, ok: true, recordId });
        publishRecordEvent({
          action: 'created',
          domain: { id: domainId, name: access.domain.name },
          record: { id: recordId, name: r.name, type: r.type, value: r.value },
          actor: { userId: req.user!.userId, source: 'ui' },
        });
      } else {
        const message = 'Failed to add ' + r.type + ' ' + r.name;
        errors.push(message);
        results.push({ line: index + 1, ok: false, error: message });
      }
    } catch (e) {
      const message = r.type + ' ' + r.name + '：' + (e instanceof Error ? e.message : String(e));
      errors.push(message);
      results.push({ line: index + 1, ok: false, error: message });
    }
  }

  if (addedIds.length > 0) {
    await logAuditOperation(req.user!.userId, 'add_records_batch', access.domain.name, { count: addedIds.length }, req);
  }

  // 批量导入是**部分成功**语义：失败的行不撤销已成功的行。
  // 因此这里统一返回 200 信封，把「哪几行成了、哪几行失败、为什么」逐行给到客户端——
  // 否则前端拿到错误就整批重试，会把已写入的记录再写一遍。
  sendSuccess(res, { total: records.length, addedIds, results, errors });
}));

/**
 * @swagger
 * /api/domains/{domainId}/records/{recordId}:
 *   put:
 *     summary: Update a DNS record
 *     tags: [Records]
 *     security:
 *       - bearerAuth: []
 */
router.put('/:recordId', authMiddleware, requireTokenDomainPermission('domainId'), asyncHandler(async (req: Request, res: Response) => {
  const domainId = parseInteger(req.params.domainId) ?? 0;
  const recordId = req.params.recordId;
  const access = await getDomainAccess(domainId, req.user!.userId, normalizeRole(req.user!.role));
  if (!access.domain || !access.canRead) {
    sendError(res, 'Domain not found', 404);
    return;
  }
  if (!access.canWrite) {
    sendError(res, 'Permission denied', 403);
    return;
  }
  const { name, type, value, line, proxied, ttl, mx, weight, remark, status, redirect, cloudflare, aliyunesa } = req.body as {
    name?: string; type?: string; value?: string; line?: string; proxied?: boolean; redirect?: string;
    ttl?: number; mx?: number; weight?: number; remark?: string; status?: number;
    cloudflare?: { proxied?: boolean };
    aliyunesa?: { proxied?: boolean };
  };
  if (!name || !type || !value) {
    sendError(res, 'name, type, and value are required');
    return;
  }
  if (!canWriteSubdomain(access.writeSubs, name, access.domain.name)) {
    sendError(res, 'Permission denied for subdomain', 403);
    return;
  }
  {
    const err = isValidRecordValue(type, value);
    if (err !== true) { sendError(res, err); return; }
  }
  const account = await DnsAccountOperations.getById(access.domain.account_id) as DnsAccount | undefined;
  if (account && !isTypeSupportedByProvider(account.type, type)) {
    sendError(res, `Record type "${type}" is not supported by provider "${account.type}"`);
    return;
  }
  if (account) {
    const proxyError = proxyCapabilityError(account.type, proxied);
    if (proxyError) { sendError(res, proxyError); return; }
  }
  try {
    const dnsAdapter = await getAdapterForDomain(access.domain);
    // line 语义收敛：line 只表示线路；CF/ESA 的代理开关走 proxied（兼容旧 cloudflare/aliyunesa.proxied 与 line:'0'/'1'）
    const { line: effectiveLine } = resolveLineInput(normalizeProviderType(account?.type ?? ''), {
      line,
      proxied,
      legacyProxied: cloudflare?.proxied ?? aliyunesa?.proxied,
    });
    // 仅在存在工作流订阅者时才回查旧值，避免给热路径增加固定开销
    const previousRecord = hasWorkflowSubscribers()
      ? await dnsAdapter.getDomainRecordInfo(recordId).catch(() => null)
      : null;
    const updateCapability = account ? providerCapability(account.type) : null;
    const updateRedirect = resolveRedirectTarget(Boolean(updateCapability?.redirect), redirect);
    if (updateRedirect.error) { sendError(res, updateRedirect.error); return; }
    if (updateRedirect.ignored) {
      log.debug('redirect ignored: provider did not declare capabilities.redirect', { providerType: account?.type });
    }
    const updateRemarkSupported = updateCapability ? updateCapability.remark !== false : true;
    const updateWeightSupported = updateCapability ? updateCapability.weight !== false : true;
    const success = await dnsAdapter.updateDomainRecord(recordId, name, type, value, effectiveLine, ttl, mx, updateWeightSupported ? weight : undefined, updateRemarkSupported ? remark : undefined);
    if (!success) {
      sendError(res, 'Failed to update record');
      return;
    }
    if (updateRedirect.target) {
      if (typeof dnsAdapter.setRecordRedirect !== 'function') {
        sendError(res, '该提供商声明支持重定向，但适配器尚未实现', 501);
        return;
      }
      const redirectOk = await dnsAdapter.setRecordRedirect(recordId, updateRedirect.target);
      if (!redirectOk) { sendError(res, '设置记录重定向失败'); return; }
    }
    await logAuditOperation(req.user!.userId, 'update_record', access.domain.name, { recordId, name, type, value, redirect: updateRedirect.target }, req);

    publishRecordEvent({
      action: 'updated',
      domain: { id: domainId, name: access.domain.name },
      record: { id: recordId, name, type, value, oldValue: previousRecord?.Value },
      actor: { userId: req.user!.userId, source: 'ui' },
    });

    // 推送 WebSocket 消息：只推给能读到该域名的用户
    await pushRecordEvent(access.domain.id, {
      type: 'record_updated',
      data: {
        recordId,
        domainId,
      },
    });

    sendSuccess(res);
  } catch (e) {
    sendError(res, e instanceof Error ? e.message : String(e));
  }
}));

/**
 * @swagger
 * /api/domains/{domainId}/records/{recordId}:
 *   delete:
 *     summary: Delete a DNS record
 *     tags: [Records]
 *     security:
 *       - bearerAuth: []
 */
router.delete('/:recordId', authMiddleware, requireTokenDomainPermission('domainId'), asyncHandler(async (req: Request, res: Response) => {
  const domainId = parseInteger(req.params.domainId) ?? 0;
  const recordId = req.params.recordId;
  const access = await getDomainAccess(domainId, req.user!.userId, normalizeRole(req.user!.role));
  if (!access.domain || !access.canRead) {
    sendError(res, 'Domain not found', 404);
    return;
  }
  if (!access.canWrite) {
    sendError(res, 'Permission denied', 403);
    return;
  }
  try {
    const dnsAdapter = await getAdapterForDomain(access.domain);
    // Only scoped writers need subdomain ownership verification.
    // Users with full-domain write permission can delete directly.
    if (access.writeSubs !== null) {
      const targetRecord = await dnsAdapter.getDomainRecordInfo(recordId);
      if (!targetRecord) {
        sendError(res, 'Record not found');
        return;
      }
      if (!canWriteSubdomain(access.writeSubs, targetRecord.Name, access.domain.name)) {
        sendError(res, 'Permission denied for subdomain', 403);
        return;
      }
    }
    // 删除事件需要记录类型；无订阅者时不回查，避免热路径固定开销
    const previousForEvent = hasWorkflowSubscribers()
      ? await findRecordMeta(dnsAdapter, recordId)
      : null;
    const success = await dnsAdapter.deleteDomainRecord(recordId);
    if (!success) {
      sendError(res, 'Failed to delete record');
      return;
    }
    await logAuditOperation(req.user!.userId, 'delete_record', access.domain.name, { recordId }, req);

    if (previousForEvent) {
      publishRecordEvent({
        action: 'deleted',
        domain: { id: domainId, name: access.domain.name },
        record: {
          id: recordId,
          name: previousForEvent.Name,
          type: previousForEvent.Type,
          value: previousForEvent.Value,
        },
        actor: { userId: req.user!.userId, source: 'ui' },
      });
    }

    // 推送 WebSocket 消息：只推给能读到该域名的用户
    await pushRecordEvent(access.domain.id, {
      type: 'record_deleted',
      data: {
        recordId,
        domainId,
      },
    });

    sendSuccess(res);
  } catch (e) {
    sendError(res, e instanceof Error ? e.message : String(e));
  }
}));

/**
 * @swagger
 * /api/domains/{domainId}/records/{recordId}/status:
 *   put:
 *     summary: Enable/disable a DNS record
 *     tags: [Records]
 *     security:
 *       - bearerAuth: []
 */
router.put('/:recordId/status', authMiddleware, requireTokenDomainPermission('domainId'), asyncHandler(async (req: Request, res: Response) => {
  const domainId = parseInteger(req.params.domainId) ?? 0;
  const recordId = req.params.recordId;
  const access = await getDomainAccess(domainId, req.user!.userId, normalizeRole(req.user!.role));
  if (!access.domain || !access.canRead) {
    sendError(res, 'Domain not found', 404);
    return;
  }
  if (!access.canWrite) {
    sendError(res, 'Permission denied', 403);
    return;
  }
  const { status } = req.body as { status: number };
  if (status !== 0 && status !== 1) {
    sendError(res, 'status must be 0 or 1');
    return;
  }
  {
    const account = await DnsAccountOperations.getById(access.domain.account_id) as DnsAccount | undefined;
    const capability = account ? providerCapability(account.type) : null;
    if (capability && !capability.status) {
      sendError(res, `提供商 "${account!.type}" 不支持启用/禁用记录`);
      return;
    }
  }
  try {
    const dnsAdapter = await getAdapterForDomain(access.domain);
    const previousForEvent = hasWorkflowSubscribers()
      ? await findRecordMeta(dnsAdapter, recordId)
      : null;
    const success = await dnsAdapter.setDomainRecordStatus(recordId, status);
    if (!success) {
      sendError(res, 'Failed to update record status');
      return;
    }
    await logAuditOperation(req.user!.userId, status === 1 ? 'enable_record' : 'disable_record', access.domain.name, { recordId });

    if (previousForEvent) {
      publishRecordEvent({
        action: 'status_changed',
        domain: { id: domainId, name: access.domain.name },
        record: {
          id: recordId,
          name: previousForEvent.Name,
          type: previousForEvent.Type,
          value: previousForEvent.Value,
        },
        actor: { userId: req.user!.userId, source: 'ui' },
      });
    }

    // 推送 WebSocket 消息：只推给能读到该域名的用户
    await pushRecordEvent(access.domain.id, {
      type: 'record_status_changed',
      data: {
        recordId,
        domainId,
        status,
      },
    });

    sendSuccess(res);
  } catch (e) {
    sendError(res, e instanceof Error ? e.message : String(e));
  }
}));

export default router;
