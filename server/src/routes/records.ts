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
import { parseInteger, sendError, sendSuccess } from '../utils/http';
import { DomainOperations, DnsAccountOperations } from '../db/bal/business-adapter';
import { hasWorkflowSubscribers, publishRecordEvent } from '../workflow/publish';
import { createLogger } from '../lib/logger';
import { wsService } from '../service/websocket';
import { normalizeDomain, isValidDomain } from '../utils/dns';
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

async function getAdapterForDomain(domain: Domain) {
  log.info('Getting adapter for domain', { domainId: domain.id, domainName: domain.name, accountId: domain.account_id, thirdId: domain.third_id });
  const account = await DnsAccountOperations.getById(domain.account_id) as DnsAccount | undefined;
  if (!account) {
    log.error('Account not found', { accountId: domain.account_id });
    throw new Error('Account not found');
  }
  log.info('Found account', { accountType: account.type, accountName: account.name });
  // MySQL JSON type returns object directly, SQLite/PostgreSQL returns string
  const cfg = typeof account.config === 'string' ? JSON.parse(account.config) as Record<string, string> : account.config as Record<string, string>;

  // For HiDNS provider, use third_id (remote domain ID) as domainId
  // For other providers, use local domain.id
  const isHiDNS = account.type === 'hidns';
  const domainId = isHiDNS && domain.third_id ? domain.third_id : String(domain.id);

  log.info('Creating adapter', { type: account.type, domain: domain.name, thirdId: domain.third_id, localDomainId: domain.id, effectiveDomainId: domainId, isHiDNS });
  const adapter = createAdapter(account.type, cfg, domain.name, domain.third_id, domainId);
  log.info('Adapter created');
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
router.get('/', authMiddleware, asyncHandler(async (req: Request, res: Response, next) => {
  log.info('=== GET /records route entered ===', { domainId: req.params.domainId, path: req.path, originalUrl: req.originalUrl });

  // 检查是否有 domainId 参数，如果没有则交给下一个路由处理（如 email-templates）
  if (!req.params.domainId) {
    log.info('No domainId parameter, passing to next route');
    return next();
  }

  const domainId = parseInteger(req.params.domainId) ?? 0;
  log.info('Parsed domainId', { domainId });
  const access = await getDomainAccess(domainId, req.user!.userId, normalizeRole(req.user!.role));
  log.info('Got domain access', { hasDomain: !!access.domain, canRead: access.canRead });
  if (!access.domain || !access.canRead) {
    sendError(res, 'Domain not found');
    return;
  }
  const { page = '1', pageSize = '100', keyword, subdomain, value, type, line, status } = req.query as Record<string, string>;
  try {
    log.info('Fetching records', { domainId: access.domain.id, page, pageSize, keyword, subdomain, value, type, line, status });
    const dnsAdapter = await getAdapterForDomain(access.domain);
    log.info('Got adapter, calling getDomainRecords');
    const result = await dnsAdapter.getDomainRecords(
      parseInt(page), parseInt(pageSize), keyword, subdomain, value, type, line,
      status !== undefined ? parseInt(status) : undefined
    );
    log.info('Got records result', { total: result.total, count: result.list.length });
    await updateDomainRecordCount(access.domain.id, result.total);
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
router.get('/export/zone', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const domainId = parseInteger(req.params.domainId) ?? 0;
  const access = await getDomainAccess(domainId, req.user!.userId, normalizeRole(req.user!.role));
  if (!access.domain || !access.canRead) {
    sendError(res, 'Domain not found');
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
    sendError(res, 'Domain not found');
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
router.post('/', authMiddleware, requireTokenDomainPermission('domainId'), asyncHandler(async (req: Request, res: Response) => {
  const domainId = parseInteger(req.params.domainId) ?? 0;
  const access = await getDomainAccess(domainId, req.user!.userId, normalizeRole(req.user!.role));
  if (!access.domain || !access.canRead) {
    sendError(res, 'Domain not found');
    return;
  }
  if (!access.canWrite) {
    sendError(res, 'Permission denied');
    return;
  }
  const { name, type, value, line, ttl, mx, weight, remark, cloudflare, aliyunesa } = req.body as {
    name: string; type: string; value: string; line?: string;
    ttl?: number; mx?: number; weight?: number; remark?: string;
    cloudflare?: { proxied?: boolean };
    aliyunesa?: { proxied?: boolean };
  };
  if (!name || !type || !value) {
    sendError(res, 'name, type, and value are required');
    return;
  }
  if (!canWriteSubdomain(access.writeSubs, name, access.domain.name)) {
    sendError(res, 'Permission denied for subdomain');
    return;
  }
  {
    const err = isValidRecordValue(type, value);
    if (err !== true) { sendError(res, err); return; }
  }
  {
    const account = await DnsAccountOperations.getById(access.domain.account_id) as DnsAccount | undefined;
    if (account && !isTypeSupportedByProvider(account.type, type)) {
      sendError(res, `Record type "${type}" is not supported by provider "${account.type}"`);
      return;
    }
  }
  try {
    const dnsAdapter = await getAdapterForDomain(access.domain);
    // 对于 Cloudflare/ESA，使用 cloudflare.proxied 或 aliyunesa.proxied 决定 line 值
    // 默认使用 '0' (仅DNS)，避免意外开启代理
    const effectiveLine = cloudflare?.proxied !== undefined
      ? (cloudflare.proxied ? '1' : '0')
      : aliyunesa?.proxied !== undefined
        ? (aliyunesa.proxied ? '1' : '0')
        : (line ?? '0');
    const recordId = await dnsAdapter.addDomainRecord(name, type, value, effectiveLine, ttl, mx, weight, remark);
    if (!recordId) {
      sendError(res, 'Failed to add record');
      return;
    }
    await logAuditOperation(req.user!.userId, 'add_record', access.domain.name, { name, type, value }, req);

    // 获取新创建的记录数据用于 WebSocket 推送
    const newRecord = await dnsAdapter.getDomainRecordInfo(recordId);

    // 发布到工作流事件总线（无订阅者时零成本；非 A/AAAA 自动丢弃）
    publishRecordEvent({
      action: 'created',
      domain: { id: domainId, name: access.domain.name },
      record: { id: recordId, name, type, value },
      actor: { userId: req.user!.userId, source: 'ui' },
    });

    // 推送 WebSocket 消息
    try {
      wsService.broadcast({
        type: 'record_created',
        data: {
          recordId,
          domainId,
          host: name,
          type,
          record: newRecord,
        },
      });
    } catch (error) {
      log.error('Failed to broadcast record_created event', { error });
    }

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

router.post('/batch', authMiddleware, requireTokenDomainPermission('domainId'), asyncHandler(async (req: Request, res: Response) => {
  const domainId = parseInteger(req.params.domainId) ?? 0;
  const access = await getDomainAccess(domainId, req.user!.userId, normalizeRole(req.user!.role));
  if (!access.domain || !access.canRead) {
    sendError(res, 'Domain not found');
    return;
  }
  if (!access.canWrite) {
    sendError(res, 'Permission denied');
    return;
  }

  const records = req.body.records as Array<{
    name: string; type: string; value: string; line?: string;
    ttl?: number; mx?: number; weight?: number; remark?: string;
  }>;

  if (!Array.isArray(records) || records.length === 0) {
    sendError(res, 'records array is required');
    return;
  }

  for (const r of records) {
    if (!r.name || !r.type || !r.value) {
      sendError(res, 'name, type, and value are required for all records');
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

  {
    const account = await DnsAccountOperations.getById(access.domain.account_id) as DnsAccount | undefined;
    if (account) {
      const unsupported = records.filter(r => !isTypeSupportedByProvider(account.type, r.type));
      if (unsupported.length > 0) {
        const types = [...new Set(unsupported.map(r => r.type))].join(', ');
        sendError(res, `Record types not supported by provider "${account.type}": ${types}`);
        return;
      }
    }
  }

  const dnsAdapter = await getAdapterForDomain(access.domain);
  const addedIds: string[] = [];
  const errors: string[] = [];

  for (const r of records) {
    try {
      const recordId = await dnsAdapter.addDomainRecord(r.name, r.type, r.value, r.line, r.ttl, r.mx, r.weight, r.remark);
      if (recordId) {
        addedIds.push(recordId);
        publishRecordEvent({
          action: 'created',
          domain: { id: domainId, name: access.domain.name },
          record: { id: recordId, name: r.name, type: r.type, value: r.value },
          actor: { userId: req.user!.userId, source: 'ui' },
        });
      } else {
        errors.push(`Failed to add ${r.type} ${r.name}`);
      }
    } catch (e) {
      errors.push(`Error adding ${r.type} ${r.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (addedIds.length > 0) {
    await logAuditOperation(req.user!.userId, 'add_records_batch', access.domain.name, { count: addedIds.length }, req);
  }

  if (errors.length > 0) {
    sendError(res, errors.join('; '), 200, { addedIds });
  } else {
    sendSuccess(res, { addedIds });
  }
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
    sendError(res, 'Domain not found');
    return;
  }
  if (!access.canWrite) {
    sendError(res, 'Permission denied');
    return;
  }
  const { name, type, value, line, ttl, mx, weight, remark, status, cloudflare, aliyunesa } = req.body as {
    name?: string; type?: string; value?: string; line?: string;
    ttl?: number; mx?: number; weight?: number; remark?: string; status?: number;
    cloudflare?: { proxied?: boolean };
    aliyunesa?: { proxied?: boolean };
  };
  if (!name || !type || !value) {
    sendError(res, 'name, type, and value are required');
    return;
  }
  if (!canWriteSubdomain(access.writeSubs, name, access.domain.name)) {
    sendError(res, 'Permission denied for subdomain');
    return;
  }
  {
    const err = isValidRecordValue(type, value);
    if (err !== true) { sendError(res, err); return; }
  }
  {
    const account = await DnsAccountOperations.getById(access.domain.account_id) as DnsAccount | undefined;
    if (account && !isTypeSupportedByProvider(account.type, type)) {
      sendError(res, `Record type "${type}" is not supported by provider "${account.type}"`);
      return;
    }
  }
  try {
    const dnsAdapter = await getAdapterForDomain(access.domain);
    // 对于 Cloudflare/ESA，使用 cloudflare.proxied 或 aliyunesa.proxied 决定 line 值
    // 默认使用 '0' (仅DNS)，避免意外开启代理
    const effectiveLine = cloudflare?.proxied !== undefined
      ? (cloudflare.proxied ? '1' : '0')
      : aliyunesa?.proxied !== undefined
        ? (aliyunesa.proxied ? '1' : '0')
        : (line ?? '0');
    // 仅在存在工作流订阅者时才回查旧值，避免给热路径增加固定开销
    const previousRecord = hasWorkflowSubscribers()
      ? await dnsAdapter.getDomainRecordInfo(recordId).catch(() => null)
      : null;
    const success = await dnsAdapter.updateDomainRecord(recordId, name, type, value, effectiveLine, ttl, mx, weight, remark);
    if (!success) {
      sendError(res, 'Failed to update record');
      return;
    }
    await logAuditOperation(req.user!.userId, 'update_record', access.domain.name, { recordId, name, type, value }, req);

    publishRecordEvent({
      action: 'updated',
      domain: { id: domainId, name: access.domain.name },
      record: { id: recordId, name, type, value, oldValue: previousRecord?.Value },
      actor: { userId: req.user!.userId, source: 'ui' },
    });

    // 推送 WebSocket 消息
    try {
      wsService.broadcast({
        type: 'record_updated',
        data: {
          recordId,
          domainId,
        },
      });
    } catch (error) {
      log.error('Failed to broadcast record_updated event', { error });
    }

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
    sendError(res, 'Domain not found');
    return;
  }
  if (!access.canWrite) {
    sendError(res, 'Permission denied');
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
        sendError(res, 'Permission denied for subdomain');
        return;
      }
    }
    // 删除事件需要记录类型；无订阅者时不回查，避免热路径固定开销
    const previousForEvent = hasWorkflowSubscribers()
      ? await dnsAdapter.getDomainRecordInfo(recordId).catch(() => null)
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

    // 推送 WebSocket 消息
    try {
      wsService.broadcast({
        type: 'record_deleted',
        data: {
          recordId,
          domainId,
        },
      });
    } catch (error) {
      log.error('Failed to broadcast record_deleted event', { error });
    }

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
    sendError(res, 'Domain not found');
    return;
  }
  if (!access.canWrite) {
    sendError(res, 'Permission denied');
    return;
  }
  const { status } = req.body as { status: number };
  if (status !== 0 && status !== 1) {
    sendError(res, 'status must be 0 or 1');
    return;
  }
  try {
    const dnsAdapter = await getAdapterForDomain(access.domain);
    const previousForEvent = hasWorkflowSubscribers()
      ? await dnsAdapter.getDomainRecordInfo(recordId).catch(() => null)
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

    // 推送 WebSocket 消息
    try {
      wsService.broadcast({
        type: 'record_status_changed',
        data: {
          recordId,
          domainId,
          status,
        },
      });
    } catch (error) {
      log.error('Failed to broadcast record_status_changed event', { error });
    }

    sendSuccess(res);
  } catch (e) {
    sendError(res, e instanceof Error ? e.message : String(e));
  }
}));

export default router;
