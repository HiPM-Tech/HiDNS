import { Router, Request, Response } from 'express';
import { authMiddleware, requireDomainPermission, requireTokenDomainPermission } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { createAdapter } from '../lib/dns/DnsHelper';
import { dnsheGetWhois } from '../lib/dns/providers';
import type { DomainInfo } from '../lib/dns/DnsInterface';
import { providerDefinitionMap } from '../lib/dns/providers/registry';
import { renewalRegistry } from '../service/renewalScheduler';
import { DnsAccount, Domain } from '../types';
import { ROLE_ADMIN, isSuper, normalizeRole } from '../utils/roles';
import { logAuditOperation } from '../service/audit';
import { parseInteger, sendError, sendSuccess, sendServerError } from '../utils/http';
import { createLogger } from '../lib/logger';
import { publishDomainEvent } from '../lib/domain-event-bus';
import { DomainOperations, DnsAccountOperations, DomainPermissionOperations, TeamOperations, RenewableDomainOperations, UserPreferencesOperations, NSMonitorOperations, SystemCacheOperations, WhoisOperations } from '../db/bal/business-adapter';
import { syncDomainWhois } from '../service/whois';
import { getRootDomain, queryWhois, groupDomains } from '../service/whois';
import { getCachedGroupedData, setCachedGroupedData, getCacheVersion, bumpCacheVersion, submitGroupedCacheUpdate } from '../service/groupedCacheJob';
import { wsService } from '../service/websocket';
import { normalizeDomain, isValidDomain, getDisplayDomain } from '../utils/dns';


const log = createLogger('HTTP').sub('Route').sub('Domains');
const router = Router();

async function getAccountForUser(accountId: number, userId: number, role: number): Promise<DnsAccount | null> {
  const account = await DnsAccountOperations.getById(accountId) as DnsAccount | undefined;
  if (!account) return null;
  if (isSuper(role) || account.created_by === userId) return account;
  if (account.team_id) {
    const isMember = await TeamOperations.isMember(account.team_id, userId);
    if (isMember) return account;
  }
  return null;
}

async function getAccountForManage(accountId: number, userId: number, role: number): Promise<DnsAccount | null> {
  const account = await getAccountForUser(accountId, userId, role);
  if (!account) return null;
  if (isSuper(role)) return account;
  if (role >= ROLE_ADMIN && account.created_by === userId) return account;
  return null;
}

type DomainAccess = {
  domain: Domain | null;
  canRead: boolean;
  canWrite: boolean;
  writeSubs: string[] | null;
  hasRules: boolean;
};

function normalizeSubInput(sub?: string): string {
  // Use IDN-aware normalization for subdomains
  const normalized = normalizeDomain(sub ?? '');
  if (normalized === '@') return '@';
  return normalized;
}

async function getPermissionRows(domainId: number, userId: number): Promise<Array<{ permission: 'read' | 'write'; sub: string }>> {
  const userPerms = await DomainPermissionOperations.getByDomainAndUser(domainId, userId) as Array<{ permission: 'read' | 'write'; sub: string }>;
  const teamPerms = await DomainPermissionOperations.getByDomainAndTeamMember(domainId, userId) as Array<{ permission: 'read' | 'write'; sub: string }>;
  return [...userPerms, ...teamPerms].map((row) => ({
    permission: row.permission,
    sub: normalizeSubInput(row.sub),
  }));
}

async function getUserPermissionRows(domainId: number, userId: number): Promise<Array<{ permission: 'read' | 'write'; sub: string }>> {
  const userPerms = await DomainPermissionOperations.getByDomainAndUser(domainId, userId) as Array<{ permission: 'read' | 'write'; sub: string }>;
  return userPerms.map((row) => ({
    permission: row.permission,
    sub: normalizeSubInput(row.sub),
  }));
}

async function resolveDomainAccess(domain: Domain, userId: number, role: number): Promise<DomainAccess> {
  // ← 新增：检查账号是否启用
  const account = await DnsAccountOperations.getById(domain.account_id);
  if (!account || (account as any).enabled === 0) {
    // 账号不存在或已禁用，拒绝所有操作（除了 WHOIS）
    return { domain, canRead: false, canWrite: false, writeSubs: [], hasRules: false };
  }

  const hasRules = await DomainPermissionOperations.hasRules(domain.id);
  if (isSuper(role)) {
    return { domain, canRead: true, canWrite: true, writeSubs: null, hasRules };
  }
  const createdBy = await DnsAccountOperations.getCreatedBy(domain.account_id);
  if (createdBy === userId && role >= ROLE_ADMIN) {
    return { domain, canRead: true, canWrite: true, writeSubs: null, hasRules };
  }
  if (hasRules) {
    const userPerms = await getUserPermissionRows(domain.id, userId);
    const perms = userPerms.length > 0 ? userPerms : await getPermissionRows(domain.id, userId);
    if (perms.length === 0) {
      return { domain, canRead: false, canWrite: false, writeSubs: [], hasRules };
    }
    const canWrite = perms.some((p) => p.permission === 'write');
    const canRead = perms.some((p) => p.permission === 'read' || p.permission === 'write');
    let writeSubs: string[] | null = [];
    if (canWrite) {
      const writePerms = perms.filter((p) => p.permission === 'write');
      const hasAll = writePerms.some((p) => !p.sub);
      writeSubs = hasAll ? null : Array.from(new Set(writePerms.map((p) => p.sub)));
    }
    return { domain, canRead, canWrite, writeSubs, hasRules };
  }
  return { domain, canRead: false, canWrite: false, writeSubs: [], hasRules };
}

async function resolveDomainAccessById(domainId: number, userId: number, role: number): Promise<DomainAccess> {
  const domain = await DomainOperations.getById(domainId) as Domain | undefined;
  if (!domain) {
    return { domain: null, canRead: false, canWrite: false, writeSubs: [], hasRules: false };
  }
  return resolveDomainAccess(domain, userId, role);
}

async function canAccessDomain(domainId: number, userId: number, role: number): Promise<Domain | null> {
  const domain = await DomainOperations.getById(domainId) as Domain | undefined;
  if (!domain) return null;
  const access = await resolveDomainAccess(domain, userId, role);
  return access.canRead ? domain : null;
}

export async function getDomainAccess(domainId: number, userId: number, role: number): Promise<DomainAccess> {
  const domain = await DomainOperations.getById(domainId) as Domain | undefined;
  if (!domain) {
    return { domain: null, canRead: false, canWrite: false, writeSubs: [], hasRules: false };
  }
  return await resolveDomainAccess(domain, userId, role);
}

/**
 * @swagger
 * /api/domains:
 *   get:
 *     summary: List domains
 *     tags: [Domains]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: account_id
 *         schema:
 *           type: integer
 *       - in: query
 *         name: keyword
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: pageSize
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: List of domains
 */
router.get('/', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const { account_id, keyword, domain_match, domain_type, page, pageSize, format, include_disabled, domain_status, pinned_domains, grouped } = req.query as {
    account_id?: string;
    keyword?: string;
    domain_match?: string;
    domain_type?: string;
    page?: string;
    pageSize?: string;
    format?: string; // 'array' for direct array response (for external adapters)
    include_disabled?: string; // 'true' to include disabled domains (legacy)
    domain_status?: 'enabled' | 'disabled' | 'all'; // new parameter for status filtering
    pinned_domains?: string; // comma-separated domain IDs for pinned sorting
    grouped?: string; // 'true' to group domains before pagination
  };
  const userId = req.user!.userId;
  const role = normalizeRole(req.user!.role);

  // Pagination params
  const currentPage = Math.max(1, parseInteger(page) || 1);
  const size = grouped === 'true' ? 100000 : Math.min(100, Math.max(1, parseInteger(pageSize) || 20));

  // Parse domain_type with type safety
  const parsedDomainType: 'apex' | 'subdomain' | undefined =
    (domain_type === 'apex' || domain_type === 'subdomain') ? domain_type : undefined;

  // Parse domain_status with fallback to legacy include_disabled parameter
  let parsedDomainStatus: 'enabled' | 'disabled' | 'all' = 'all';
  if (domain_status === 'enabled' || domain_status === 'disabled' || domain_status === 'all') {
    parsedDomainStatus = domain_status;
  } else if (include_disabled === 'false') {
    // Legacy behavior: include_disabled=false means only enabled
    parsedDomainStatus = 'enabled';
  }
  // If include_disabled=true or not specified, default to 'all'

  // Parse pinned_domains (comma-separated string to number array)
  const pinnedDomainIds: number[] = pinned_domains
    ? pinned_domains.split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id))
    : [];

  // Debug log
  log.info('Query params', {
    pinned_domains,
    pinnedDomainIds,
    page: currentPage,
    pageSize: size,
    userId,
    role
  });

  // Check if using token auth and get allowed domains
  const tokenPayload = (req as any).tokenPayload;
  const tokenAllowedDomains = tokenPayload?.allowedDomains as number[] | undefined;

  let domains: Domain[];
  let total = 0; // 初始化 total

  // Token 认证优化：根据 allowedDomains 是否为空选择不同策略
  if (tokenPayload) {
    const queryStartTime = Date.now();
    if (tokenAllowedDomains && tokenAllowedDomains.length > 0) {
      // 有限制的 Token：直接根据 ID 列表查询，性能最优
      domains = await DomainOperations.getByIds(tokenAllowedDomains, {
        accountId: account_id ? parseInteger(account_id) : undefined,
        keyword,
        domainMatch: domain_match,
      }) as unknown as Domain[];
    } else {
      // 允许所有域名的 Token：根据角色选择查询方式
      if (isSuper(role)) {
        // 超管：使用优化的分页查询（支持 enabled 过滤）
        const result = await DomainOperations.getAllForSuperAdminWithPagination({
          accountId: account_id ? parseInteger(account_id) : undefined,
          keyword,
          domainMatch: domain_match,
          domainStatus: parsedDomainStatus,
          domainType: parsedDomainType,
          pinnedDomainIds,  // ← 传递置顶域名 ID 列表
          page: currentPage,
          pageSize: size,
        });
        domains = result.list as unknown as Domain[];
        total = result.total;
      } else {
        // 普通用户 Token：使用权限检查逻辑
        const teamIds = await TeamOperations.getTeamIdsByUserId(userId);
        const result = await DomainOperations.getAccessibleDomainsWithPagination({
          userId,
          teamIds,
          accountId: account_id ? parseInteger(account_id) : undefined,
          keyword,
          domainMatch: domain_match,
          domainStatus: parsedDomainStatus,
          domainType: parsedDomainType,
          pinnedDomainIds,  // ← 传递置顶域名 ID 列表
          page: currentPage,
          pageSize: size,
        });
        domains = result.list as unknown as Domain[];
        total = result.total;
      }
    }
    log.debug('Token auth domain query completed', {
      duration: `${Date.now() - queryStartTime}ms`,
      count: domains.length,
      total
    });
  } else {
    // Session 认证：根据角色选择查询方式
    if (isSuper(role)) {
      // 超管：使用优化的分页查询（支持 enabled 过滤）
      const result = await DomainOperations.getAllForSuperAdminWithPagination({
        accountId: account_id ? parseInteger(account_id) : undefined,
        keyword,
        domainStatus: parsedDomainStatus,
        domainType: parsedDomainType,
        pinnedDomainIds,  // ← 传递置顶域名 ID 列表
        page: currentPage,
        pageSize: size,
      });
      domains = result.list as unknown as Domain[];
      total = result.total;
    } else {
      // 普通用户：使用权限检查逻辑
      const teamIds = await TeamOperations.getTeamIdsByUserId(userId);
      const result = await DomainOperations.getAccessibleDomainsWithPagination({
        userId,
        teamIds,
        accountId: account_id ? parseInteger(account_id) : undefined,
        keyword,
        domainStatus: parsedDomainStatus,
        domainType: parsedDomainType,
        pinnedDomainIds,  // ← 传递置顶域名 ID 列表
        page: currentPage,
        pageSize: size,
      });
      domains = result.list as unknown as Domain[];
      total = result.total;
    }
  }

  // Token 认证已经在上面过滤了 allowedDomains，不需要再进行权限检查
  // 只有非 Token 认证的非超级管理员才需要逐个检查权限
  if (!isSuper(role) && !tokenPayload) {
    domains = await Promise.all(domains.map(async (domain) => {
      const access = await resolveDomainAccess(domain, userId, role);
      return access.canRead ? domain : null;
    })).then(results => results.filter((d): d is Domain => d !== null));
    // 注意：这种情况下 total 可能不准确，但不影响功能
  }

  // ← 后端已在数据库层面按置顶排序，前端不需要再排序

  // Record count is cached in database and refreshed asynchronously by background job
  // No need to query DNS provider API on every request

  // When grouped=true: group all fetched domains, then paginate the display items by group blocks
  if (grouped === 'true' && !tokenPayload && format !== 'array') {
    // Try cache first (stores full unfiltered domain list)
    const cacheVer = await getCacheVersion();
    const cached = await getCachedGroupedData(userId, 'domain');
    let allDomains: Domain[];

    if (cached && cached.ver === cacheVer) {
      allDomains = cached.data;
    } else {
      // Re-query without filters to get the full domain list for caching
      if (isSuper(role)) {
        allDomains = await DomainOperations.getAllForSuperAdmin() as unknown as Domain[];
      } else if (tokenPayload) {
        allDomains = domains; // Already fetched without pagination
      } else {
        const teamIds = await TeamOperations.getTeamIdsByUserId(userId);
        allDomains = await DomainOperations.getAccessibleDomains({
          userId, teamIds, isSuper: false,
        }) as unknown as Domain[];
      }
      const ver = await bumpCacheVersion();
      await setCachedGroupedData(userId, 'domain', ver, allDomains);
    }

    // Apply in-memory filters on the cached full list
    if (parsedDomainStatus === 'enabled') {
      allDomains = allDomains.filter((d: any) => d.enabled !== 0 && d.enabled !== false);
    } else if (parsedDomainStatus === 'disabled') {
      allDomains = allDomains.filter((d: any) => d.enabled === 0 || d.enabled === false);
    }
    if (parsedDomainType === 'apex') {
      allDomains = allDomains.filter((d) => !d.name.includes('.') || d.name.split('.').length <= 2);
    } else if (parsedDomainType === 'subdomain') {
      allDomains = allDomains.filter((d) => d.name.includes('.') && d.name.split('.').length > 2);
    }
    if (keyword) {
      const kw = keyword.toLowerCase();
      allDomains = allDomains.filter((d) => d.name.toLowerCase().includes(kw));
    }
    if (account_id) {
      const aid = parseInteger(account_id);
      if (aid) allDomains = allDomains.filter((d) => d.account_id === aid);
    }

    const { groups, standalone } = groupDomains(allDomains, pinnedDomainIds);

    // Sort standalone: pinned domains first, then others
    const pinnedSet = new Set(pinnedDomainIds);
    standalone.sort((a, b) => {
      const aPinned = pinnedSet.has(a.id) ? 0 : 1;
      const bPinned = pinnedSet.has(b.id) ? 0 : 1;
      return aPinned - bPinned;
    });

    // Build group blocks: each block is [group_header, ...children]
    const blocks: any[][] = [];
    for (const g of groups) {
      const headerId = -(g.parent.id);
      const childrenWithInfo = g.children.map((c: any) => ({
        ...c,
        _groupParentId: headerId,
      }));
      blocks.push([
        { _type: 'group_header', id: headerId, groupName: g.parent.name, childIds: g.children.map((c: any) => c.id) },
        ...childrenWithInfo,
      ]);
    }
    // Standalone domains: each is its own block
    for (const d of standalone) {
      blocks.push([d]);
    }

    // Group-aware pagination: each block (a group or a standalone domain) counts as 1 display row
    const pageSizeActual = Math.max(1, parseInteger(pageSize) || 20);
    const pagedBlocks: any[][] = [];
    let currentBlockAcc: any[] = [];
    let currentBlockCount = 0;

    for (const block of blocks) {
      if (currentBlockCount >= pageSizeActual && currentBlockAcc.length > 0) {
        pagedBlocks.push(currentBlockAcc);
        currentBlockAcc = [];
        currentBlockCount = 0;
      }
      currentBlockAcc.push(...block);
      currentBlockCount++;
    }
    if (currentBlockAcc.length > 0) pagedBlocks.push(currentBlockAcc);

    const groupedTotalPages = pagedBlocks.length;
    const safePage = Math.max(1, Math.min(currentPage, groupedTotalPages));
    const pageItems = pagedBlocks[safePage - 1] ?? [];

    // Convert Punycode to Unicode for display
    const displayList = pageItems.map((item: any) => {
      if (item._type === 'group_header') return item;
      return { ...item, name: getDisplayDomain(item.name, true) };
    });

    sendSuccess(res, { list: displayList, total: standalone.length + groups.length, page: safePage, pageSize: pageSizeActual, totalPages: groupedTotalPages });
    return;
  }

  const totalPages = Math.ceil(total / size);

  // Return format based on query parameter or token usage
  // For external adapters (ddns-go, certd), return direct array when format=array
  // For Token auth, return raw Punycode domains with display_name for IDN support
  // For Session auth, convert Punycode to Unicode for display
  if (format === 'array' || tokenPayload) {
    // Token auth or array format: return domains with both name and display_name
    const domainsWithDisplay = domains.map(domain => ({
      ...domain,
      display_name: getDisplayDomain(domain.name, true), // Add Unicode display name
    }));
    sendSuccess(res, domainsWithDisplay);
  } else {
    // Session auth: convert Punycode to Unicode for display
    const displayDomains = domains.map(domain => ({
      ...domain,
      name: getDisplayDomain(domain.name, true), // Convert to Unicode
    }));
    sendSuccess(res, { list: displayDomains, total, page: currentPage, pageSize: size, totalPages });
  }
}));

/**
 * @swagger
 * /api/domains:
 *   post:
 *     summary: Add a domain
 *     tags: [Domains]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [account_id, name]
 *             properties:
 *               account_id:
 *                 type: integer
 *               name:
 *                 type: string
 *               third_id:
 *                 type: string
 *               remark:
 *                 type: string
 *     responses:
 *       200:
 *         description: Domain added
 */

/**
 * ⚠️ IMPORTANT: Static routes MUST be defined BEFORE dynamic routes (/:id)
 * Express matches routes in definition order. If /:id is defined first,
 * it will match '/renewable-domains' as an ID parameter, causing 404 errors.
 *
 * Route priority order:
 * 1. Exact static routes (e.g., /renewable-domains)
 * 2. Prefixed static routes (e.g., /renewable-domains/sync)
 * 3. Dynamic routes (e.g., /:id) - should be last as fallback
 */

/**
 * Get renewable domains from all providers that support renewal
 * This endpoint queries the database for domains with expiry information
 */
router.get('/renewable-domains', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  // Only allow admins and super admins
  const role = normalizeRole(req.user?.role);
  log.info('Renewable domains request', { userId: req.user?.userId, role });

  if (role < 2) {
    log.warn('Unauthorized attempt to fetch renewable domains', { userId: req.user?.userId, role });
    sendError(res, 'Permission denied');
    return;
  }

  log.info('Fetching renewable domains', { userId: req.user?.userId });

  try {
    const page = Math.max(1, parseInteger(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInteger(req.query.pageSize) || 20));
    const keyword = req.query.keyword as string | undefined;
    const accountId = req.query.account_id ? parseInteger(req.query.account_id) : undefined;
    const status = (req.query.status as string) || 'all';
    const parsedStatus = (status === 'enabled' || status === 'disabled') ? status : undefined;

    // Query from renewable_domains table with pagination & filtering
    const startTime = Date.now();
    log.debug('Calling RenewableDomainOperations.getAllWithPagination()');
    const { list: renewableDomains, total } = await RenewableDomainOperations.getAllWithPagination({
      page, pageSize, keyword, accountId, status: parsedStatus,
    });
    const queryDuration = Date.now() - startTime;

    log.info('Fetched renewable domains from database', {
      count: renewableDomains.length,
      total,
      duration: `${queryDuration}ms`
    });

    // Enrich with account information (account_name already included in query)
    const enrichStartTime = Date.now();
    const tokenPayload = (req as any).tokenPayload;
    const enrichedDomains = await Promise.all(
      renewableDomains.map(async (domain: any) => {
        const domainName = tokenPayload ? domain.full_domain : getDisplayDomain(domain.full_domain, true);
        return {
          id: domain.id,
          name: domainName,
          full_domain: domainName,
          account_id: domain.account_id,
          account_name: domain.account_name || 'Unknown',
          provider_type: domain.provider_type,
          expires_at: domain.expires_at,
          third_id: domain.third_id,
          remark: domain.remark,
          enabled: domain.enabled,
          last_renewed_at: domain.last_renewed_at,
        };
      })
    );
    const enrichDuration = Date.now() - enrichStartTime;

    log.debug('Enriched domains with account info', {
      count: enrichedDomains.length,
      duration: `${enrichDuration}ms`
    });

    log.info('Successfully fetched renewable domains', {
      total,
      totalDuration: `${Date.now() - startTime}ms`
    });

    const counts = await RenewableDomainOperations.getStatusCounts();
    sendSuccess(res, { list: enrichedDomains, total, page, pageSize, ...counts });
  } catch (error) {
    log.error('Failed to fetch renewable domains', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    sendError(res, 'Failed to fetch renewable domains');
  }
}));

/**
 * @swagger
 * /domains/{id}:
 *   get:
 *     summary: Get domain by ID
 *     tags: [Domains]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Domain details
 */
// ⚠️ WARNING: This dynamic route must be defined AFTER all static routes
// to prevent it from matching paths like '/renewable-domains' as an ID parameter
router.get('/:id', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    // ← 新增：使用 getDomainAccess 检查权限（包括账号 enabled 状态）
    const access = await getDomainAccess(Number(id), req.user!.userId, normalizeRole(req.user!.role));
    if (!access.domain || !access.canRead) {
      sendError(res, 'Domain not found or no permission');
      return;
    }

    const domain = access.domain;

    // For Session auth, convert Punycode to Unicode for display
    // For Token auth, return raw Punycode
    const tokenPayload = (req as any).tokenPayload;
    if (!tokenPayload) {
      // Session auth: convert to Unicode
      const domainObj = domain as any;
      domainObj.name = getDisplayDomain(domainObj.name, true);
      sendSuccess(res, domainObj);
    } else {
      // Token auth: return raw
      sendSuccess(res, domain);
    }
  } catch (error) {
    log.error('Failed to get domain', { error });
    sendError(res, error instanceof Error ? error.message : 'Failed to get domain');
  }
}));

router.post('/', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const {
    account_id,
    name,
    third_id = '',
    remark = '',
    domains,
  } = req.body as {
    account_id: number;
    name?: string;
    third_id?: string;
    remark?: string;
    domains?: Array<{ name: string; third_id?: string; record_count?: number; remark?: string }>;
  };
  if (!account_id || (!name && (!domains || domains.length === 0))) {
    sendError(res, 'account_id and domain name are required');
    return;
  }
  const account = await getAccountForManage(account_id, req.user!.userId, normalizeRole(req.user!.role));
  if (!account) {
    sendError(res, 'Account not found or access denied');
    return;
  }
  const items = (domains && domains.length > 0)
    ? domains.map(d => ({ ...d, remark: d.remark ?? remark }))
    : [{ name: name!, third_id, remark, record_count: 0 }];

  const normalizedMap = new Map<string, { name: string; third_id?: string; record_count?: number; remark?: string }>();
  for (const item of items) {
    const normalizedName = normalizeDomain(item.name);
    if (!normalizedName) continue;
    normalizedMap.set(normalizedName, {
      name: normalizedName,
      third_id: item.third_id?.trim() || '',
      record_count: item.record_count ?? 0,
      remark: item.remark ?? '',
    });
  }

  if (normalizedMap.size === 0) {
    sendError(res, 'No valid domain names provided');
    return;
  }

  let added = 0;
  let firstId: number | null = null;
  const addedDomains: string[] = [];
  const duplicates: string[] = [];

  for (const item of normalizedMap.values()) {
    const existing = await DomainOperations.getByAccountIdAndName(account_id, item.name);
    if (existing) {
      await DomainOperations.updateThirdIdAndRecordCount(existing.id as number, item.third_id || '', item.record_count ?? 0);
      duplicates.push(item.name);
      continue;
    }
    try {
      const id = await DomainOperations.create({
        account_id,
        name: item.name,
        third_id: item.third_id || '',
        record_count: item.record_count ?? 0,
        remark: item.remark,
      });
      if (firstId === null) firstId = id;
      added++;
      addedDomains.push(item.name);

      publishDomainEvent({
        action: 'created',
        domain: { id, name: item.name, accountId: account_id },
        actor: { userId: req.user!.userId, source: 'ui' },
      });

      // 异步获取 WHOIS 信息（不阻塞响应），强制刷新以获取最新的多状态
      syncDomainWhois(id, true).catch(err => {
        log.warn(`Failed to sync WHOIS for ${item.name}:`, { error: err });
      });
    } catch (error) {
      if (error instanceof Error && error.message.toLowerCase().includes('unique')) {
        duplicates.push(item.name);
      } else {
        throw error;
      }
    }
  }

  if (added === 0) {
    sendError(res, duplicates.length > 0 ? `Domain already exists: ${duplicates.join(', ')}` : 'No domain added');
    return;
  }

  // 缓存失效：增量更新缓存的域名列表
  if (firstId) {
    const newDomain = await DomainOperations.getById(firstId) as unknown as Domain | undefined;
    if (newDomain) {
      // Update both user cache and super admin cache
      await submitGroupedCacheUpdate(req.user!.userId, 'domain', { type: 'create', item: newDomain });
      if (req.user!.userId !== 0) {
        await submitGroupedCacheUpdate(0, 'domain', { type: 'create', item: newDomain });
      }
    }
  }

  for (const domainName of addedDomains) {
    await logAuditOperation(req.user!.userId, 'add_domain', domainName, { accountId: account_id }, req);
  }

  // 推送 WebSocket 消息
  try {
    wsService.broadcast({
      type: 'domain_created',
      data: {
        domainId: firstId,
        name: addedDomains.length === 1 ? addedDomains[0] : `${addedDomains.length} domains`,
        count: added,
      },
    });
  } catch (error) {
    log.error('Failed to broadcast domain_created event', { error });
  }

  sendSuccess(res, { id: firstId, added, skipped: duplicates.length, duplicates });
}));

/**
 * @swagger
 * /api/domains/sync:
 *   post:
 *     summary: Sync domains from provider
 *     tags: [Domains]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [account_id]
 *             properties:
 *               account_id:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Sync result
 */
router.post('/sync', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const { account_id } = req.body as { account_id: number };
  if (!account_id) {
    sendError(res, 'account_id is required');
    return;
  }
  const account = await getAccountForManage(account_id, req.user!.userId, normalizeRole(req.user!.role));
  if (!account) {
    sendError(res, 'Account not found or access denied');
    return;
  }
  try {
    // MySQL JSON type returns object directly, SQLite/PostgreSQL returns string
    const cfg = typeof account.config === 'string' ? JSON.parse(account.config) as Record<string, string> : account.config as Record<string, string>;
    const dnsAdapter = createAdapter(account.type, cfg);

    // 分页获取所有域名
    const allDomains: DomainInfo[] = [];
    let page = 1;
    const pageSize = 50;
    let hasMore = true;

    const maxPages = 2000; // 最大页数限制（2000页 x 50个 = 10万个）

    while (hasMore) {
      try {
        const result = await dnsAdapter.getDomainList(undefined, page, pageSize);
        allDomains.push(...result.list);
        // 改进的分页判断：当返回数据少于pageSize，或已达到/超过预期总数时停止
        hasMore = result.list.length === pageSize && (page - 1) * pageSize + result.list.length < result.total;
        page++;

        // 安全限制：最多获取10万个域名或2000页防止无限循环
        if (allDomains.length >= 100000 || page > maxPages) {
          log.warn(`Sync domain limit reached (${allDomains.length} domains, ${page} pages), stopping pagination`);
          break;
        }
      } catch (error) {
        log.error(`Failed to fetch page ${page}:`, { error });
        break;
      }
    }

    log.info(`Sync fetched ${allDomains.length} domains from provider`, { accountId: account_id, provider: account.type });

    let added = 0;
    for (const d of allDomains) {
      const normalizedName = normalizeDomain(d.Domain);
      const adapterData = d.AdapterData !== undefined ? JSON.stringify(d.AdapterData) : undefined;

      // 记录 IDN 域名转换信息
      if (normalizedName !== d.Domain.toLowerCase()) {
        log.debug('IDN domain normalized during sync', {
          original: d.Domain,
          normalized: normalizedName,
          accountId: account_id,
        });
      }

      const existing = await DomainOperations.getByAccountIdAndName(account_id, normalizedName);
      if (!existing) {
        const id = await DomainOperations.create({
          account_id,
          name: normalizedName,
          third_id: d.ThirdId,
          record_count: d.RecordCount ?? 0,
          adapter_data: adapterData ?? null,
        });
        added++;

        // 同步发现的新域名同样属于生命周期事件（此前完全静默）
        publishDomainEvent({
          action: 'created',
          domain: { id, name: normalizedName, accountId: account_id },
          actor: { userId: req.user!.userId, source: 'ui' },
        });
        log.info(`Domain added during sync: ${normalizedName}`, {
          originalName: d.Domain,
          accountId: account_id,
          isIdn: normalizedName !== d.Domain.toLowerCase(),
        });
        await logAuditOperation(req.user!.userId, 'sync_add_domain', normalizedName, { accountId: account_id }, req);

        // 异步获取 WHOIS 信息（不阻塞响应）
        syncDomainWhois(id).catch(err => {
          log.warn(`Failed to sync WHOIS for ${normalizedName}:`, { error: err });
        });
      } else {
        await DomainOperations.updateThirdIdAndRecordCount(existing.id as number, d.ThirdId || '', d.RecordCount ?? 0);
      }
    }
    await logAuditOperation(req.user!.userId, 'sync_domains', '', { accountId: account_id, total: allDomains.length, added }, req);
    // 缓存失效：同步可能添加/更新多个域名
    await bumpCacheVersion();
    sendSuccess(res, { total: allDomains.length, added });
  } catch (e) {
    sendError(res, e instanceof Error ? e.message : String(e));
  }
}));

/**
 * @swagger
 * /api/domains/provider-list/{accountId}:
 *   get:
 *     summary: List domains available from a DNS provider account
 *     tags: [Domains]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: accountId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of domains from provider
 */
router.get('/provider-list/:accountId', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const accountId = parseInteger(req.params.accountId) ?? 0;
  const account = await getAccountForManage(accountId, req.user!.userId, normalizeRole(req.user!.role));
  if (!account) {
    sendError(res, 'Account not found or access denied');
    return;
  }
  try {
    // MySQL JSON type returns object directly, SQLite/PostgreSQL returns string
    const cfg = typeof account.config === 'string' ? JSON.parse(account.config) as Record<string, string> : account.config as Record<string, string>;
    log.info('Fetching domains', { accountType: account.type, configKeys: Object.keys(cfg) });
    const dnsAdapter = createAdapter(account.type, cfg);

    // 分页获取所有域名
    const allProviderDomains: Array<{ Domain: string; ThirdId: string; RecordCount?: number }> = [];
    let page = 1;
    const pageSize = 50;
    let hasMore = true;
    const maxPages = 2000;

    while (hasMore) {
      try {
        const result = await dnsAdapter.getDomainList(undefined, page, pageSize);
        allProviderDomains.push(...result.list);
        hasMore = result.list.length === pageSize && (page - 1) * pageSize + result.list.length < result.total;
        page++;

        if (allProviderDomains.length >= 100000 || page > maxPages) {
          log.warn(`Domain limit reached (${allProviderDomains.length} domains, ${page} pages), stopping pagination`);
          break;
        }
      } catch (error) {
        log.error(`Failed to fetch page ${page}:`, { error });
        break;
      }
    }

    log.info('Domains fetched', { total: allProviderDomains.length });

    // 获取所有已有域名（跨账号检测）
    const allDomains = await WhoisOperations.getAllDomains() as Array<{ id: number; name: string; account_id: number }>;
    const existingForAccount = allDomains.filter((d) => d.account_id === accountId);
    const existingDomainNames = new Set(existingForAccount.map((d) => normalizeDomain(d.name)));
    const allDomainNames = new Set(allDomains.map((d) => normalizeDomain(d.name)));

    // 返回所有域名，标记存在状态
    const tokenPayload = (req as any).tokenPayload;
    const domains = allProviderDomains.map((d) => {
      const normalizedName = normalizeDomain(d.Domain);
      // For Session auth, convert to Unicode; for Token auth, keep Punycode
      const displayName = tokenPayload ? normalizedName : getDisplayDomain(normalizedName, true);
      // 检查上级域名是否存在：移除第一个标签后的剩余部分，如 a.a.com → a.com
      const dotIdx = normalizedName.indexOf('.');
      const parentDomain = dotIdx > 0 ? normalizedName.slice(dotIdx + 1) : '';
      return {
        name: displayName,
        third_id: d.ThirdId,
        record_count: d.RecordCount ?? 0,
        exists: existingDomainNames.has(normalizedName),
        existsOther: !existingDomainNames.has(normalizedName) && allDomainNames.has(normalizedName),
        parentExists: !!parentDomain && parentDomain !== normalizedName && allDomainNames.has(normalizeDomain(parentDomain)),
      };
    });

    log.info('Provider domains fetched', { total: allProviderDomains.length, existing: existingDomainNames.size });
    sendSuccess(res, domains);
  } catch (e) {
    log.error('Error fetching domains', e);
    sendError(res, e instanceof Error ? e.message : String(e));
  }
}));

/**
 * @swagger
 * /api/domains/{id}:
 *   get:
 *     summary: Get domain info
 *     tags: [Domains]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Domain info
 */

/**
 * @swagger
 * /api/domains/{id}:
  const id = parseInteger(req.params.id) ?? 0;
  const access = await getDomainAccess(id, req.user!.userId, normalizeRole(req.user!.role));
  if (!access.domain || !access.canRead) {
    sendError(res, 'Domain not found');
    return;
  }
  sendSuccess(res, access.domain);
}));

/**
 * @swagger
 * /api/domains/{id}:
 *   put:
 *     summary: Update domain
 *     tags: [Domains]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               remark:
 *                 type: string
 *               is_hidden:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Domain updated
 */
router.put('/:id', authMiddleware, requireTokenDomainPermission(), asyncHandler(async (req: Request, res: Response) => {
  const id = parseInteger(req.params.id) ?? 0;
  const access = await getDomainAccess(id, req.user!.userId, normalizeRole(req.user!.role));
  if (!access.domain || !access.canRead) {
    sendError(res, 'Domain not found');
    return;
  }
  if (!access.canWrite) {
    sendError(res, 'Permission denied');
    return;
  }
  const { remark, is_hidden, enabled } = req.body as { remark?: string; is_hidden?: number; enabled?: number };
  await DomainOperations.updateRemarkAndHidden(id, remark, is_hidden);

  // Update enabled status if provided
  if (enabled !== undefined) {
    await DomainOperations.setEnabled(id, enabled);
  }

  await logAuditOperation(req.user!.userId, 'update_domain', access.domain.name, { remark, is_hidden, enabled }, req);

  // 主核心事件主线：域名元信息变更（**不含解析值**）。
  // 字段白名单由 buildDomainEvent 再过滤一次，只有 remark / is_hidden / enabled 会产生事件。
  publishDomainEvent({
    action: 'updated',
    domain: { id, name: access.domain.name, accountId: access.domain.account_id as number | undefined },
    changedFields: [
      ...(remark !== undefined ? ['remark'] : []),
      ...(is_hidden !== undefined ? ['is_hidden'] : []),
      ...(enabled !== undefined ? ['enabled'] : []),
    ],
    actor: { userId: req.user!.userId, source: 'ui' },
  });

  // 获取更新后的域名信息（包含到期时间）
  const updatedDomain = await DomainOperations.getById(id) as unknown as Domain | undefined;

  // 缓存失效：增量更新缓存的域名列表
  if (updatedDomain) {
    await submitGroupedCacheUpdate(req.user!.userId, 'domain', { type: 'update', item: updatedDomain });
    if (!isSuper(normalizeRole(req.user!.role))) {
      await submitGroupedCacheUpdate(0, 'domain', { type: 'update', item: updatedDomain });
    }
  }

  // 推送 WebSocket 消息
  try {
    wsService.broadcast({
      type: 'domain_updated',
      data: {
        domainId: id,
        name: access.domain.name,
        enabled: enabled !== undefined ? enabled : access.domain.enabled,
        expiresAt: (updatedDomain as any)?.expires_at || null,
        apexExpiresAt: (updatedDomain as any)?.apex_expires_at || null,
        whoisStatus: (updatedDomain as any)?.whois_status || null,
      },
    });
  } catch (error) {
    log.error('Failed to broadcast domain_updated event', { error });
  }

  sendSuccess(res);
}));

/**
 * @swagger
 * /api/domains/{id}:
 *   delete:
 *     summary: Delete domain
 *     tags: [Domains]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Domain deleted
 */
router.delete('/:id', authMiddleware, requireTokenDomainPermission(), asyncHandler(async (req: Request, res: Response) => {
  const id = parseInteger(req.params.id) ?? 0;
  const access = await getDomainAccess(id, req.user!.userId, normalizeRole(req.user!.role));
  if (!access.domain || !access.canRead) {
    sendError(res, 'Domain not found');
    return;
  }
  if (!access.canWrite) {
    sendError(res, 'Permission denied');
    return;
  }
  const deletedDomain = access.domain;
  await DomainOperations.delete(id);

  publishDomainEvent({
    action: 'deleted',
    domain: { id, name: String(deletedDomain.name) },
    actor: { userId: req.user!.userId, source: 'ui' },
  });

  // 缓存失效：增量更新缓存的域名列表
  await submitGroupedCacheUpdate(req.user!.userId, 'domain', { type: 'delete', item: deletedDomain as unknown as Domain });
  if (!isSuper(normalizeRole(req.user!.role))) {
    await submitGroupedCacheUpdate(0, 'domain', { type: 'delete', item: deletedDomain as unknown as Domain });
  }

  // Check if there are any other domains with the same name
  const domainName = access.domain.name as string;
  const remainingDomains = await DomainOperations.getAll();
  const hasSameNameDomain = remainingDomains.some((d: any) => d.name === domainName);

  // If no other domains with this name exist, delete NS monitor configs
  if (!hasSameNameDomain) {
    log.info('No remaining domains with this name, deleting NS monitors', { domainName });
    // Find and delete NS monitor configs for this domain name
    const userId = req.user!.userId;
    try {
      const monitors = await NSMonitorOperations.getUserMonitors(userId);
      for (const monitor of monitors) {
        if ((monitor as any).domain_name === domainName) {
          await NSMonitorOperations.delete(monitor.id as number, userId);
          log.info('Deleted NS monitor for removed domain', {
            monitorId: monitor.id,
            domainName,
          });
        }
      }
    } catch (error) {
      log.error('Failed to cleanup NS monitors', { error });
    }
  }

  await logAuditOperation(req.user!.userId, 'delete_domain', access.domain.name, { domainId: id, accountId: access.domain.account_id }, req);

  // 推送 WebSocket 消息
  try {
    wsService.broadcast({
      type: 'domain_deleted',
      data: {
        domainId: id,
        name: access.domain.name,
      },
    });
  } catch (error) {
    log.error('Failed to broadcast domain_deleted event', { error });
  }

  sendSuccess(res);
}));

/**
 * @deprecated 批量删除功能已禁用
 * @swagger
 * /api/domains/batch-delete:
 *   post:
 *     summary: Batch delete domains (DISABLED)
 *     tags: [Domains]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       403:
 *         description: Feature disabled
 */
router.post('/batch-delete', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  // ← 功能已禁用
  sendError(res, 'Batch delete feature is currently disabled', 403);
}));

/**
 * @swagger
 * /api/domains/{id}/lines:
 *   get:
 *     summary: Get record lines for domain
 *     tags: [Domains]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Record lines
 */
const LINES_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function linesCacheKey(accountId: number): string {
  return `lines:${accountId}`;
}

router.get('/:id/lines', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const id = parseInteger(req.params.id) ?? 0;
  const access = await getDomainAccess(id, req.user!.userId, normalizeRole(req.user!.role));
  if (!access.domain || !access.canRead) {
    sendError(res, 'Domain not found');
    return;
  }
  const accountId = access.domain.account_id;
  const account = await DnsAccountOperations.getById(accountId) as DnsAccount | undefined;
  if (!account) {
    sendError(res, 'Account not found');
    return;
  }

  // Check DB cache
  const cached = await SystemCacheOperations.get(linesCacheKey(accountId));
  if (cached) {
    try {
      sendSuccess(res, JSON.parse(cached));
      return;
    } catch {
      // Stale entry, ignore and re-fetch
    }
  }

  try {
    const cfg = typeof account.config === 'string' ? JSON.parse(account.config) as Record<string, string> : account.config as Record<string, string>;
    const dnsAdapter = createAdapter(account.type, cfg, access.domain.name, access.domain.third_id);
    const lines = await dnsAdapter.getRecordLines();
    await SystemCacheOperations.set(
      linesCacheKey(accountId),
      JSON.stringify(lines),
      new Date(Date.now() + LINES_CACHE_TTL_MS)
    );
    sendSuccess(res, lines);
  } catch (e) {
    sendError(res, e instanceof Error ? e.message : String(e));
  }
}));

/**
 * @swagger
 * /api/domains/{id}/record-types:
 *   get:
 *     summary: Get supported record types for domain
 *     tags: [Domains]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Supported record types with metadata
 */
router.get('/:id/record-types', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const id = parseInteger(req.params.id) ?? 0;
  const access = await getDomainAccess(id, req.user!.userId, normalizeRole(req.user!.role));
  if (!access.domain || !access.canRead) {
    sendError(res, 'Domain not found');
    return;
  }
  const account = await DnsAccountOperations.getById(access.domain.account_id) as DnsAccount | undefined;
  if (!account) {
    sendError(res, 'Account not found');
    return;
  }

  // For adapters that support dynamic record types (e.g. hidns_v2), query upstream
  try {
    const cfg = typeof account.config === 'string' ? JSON.parse(account.config) as Record<string, string> : account.config as Record<string, string>;
    const dnsAdapter = createAdapter(account.type, cfg, access.domain.name, access.domain.third_id);
    if (typeof (dnsAdapter as any).getRecordTypes === 'function') {
      const types = await (dnsAdapter as any).getRecordTypes();
      if (Array.isArray(types) && types.length > 0) {
        // Normalize to string array
        const normalized = types.map((t: any) => (typeof t === 'string' ? t : t.type)).filter(Boolean);
        sendSuccess(res, normalized);
        return;
      }
    }
  } catch { /* fall through to registry */ }

  const def = providerDefinitionMap.get(account.type);
  if (!def || !def.capabilities?.dns) {
    sendSuccess(res, []);
    return;
  }
  sendSuccess(res, def.capabilities.dns.recordTypes || []);
}));

/**
 * @swagger
 * /api/domains/{id}/whois:
 *   post:
 *     summary: Refresh WHOIS info for domain
 *     tags: [Domains]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: WHOIS refreshed
 */
router.post('/:id/whois', authMiddleware, requireTokenDomainPermission(), asyncHandler(async (req: Request, res: Response) => {
  const id = parseInteger(req.params.id) ?? 0;
  const access = await getDomainAccess(id, req.user!.userId, normalizeRole(req.user!.role));
  if (!access.domain || !access.canRead) {
    sendError(res, 'Domain not found');
    return;
  }

  const result = await syncDomainWhois(id);

  if (result.success) {
    sendSuccess(res, {
      expires_at: result.expiresAt?.toISOString(),
      apex_expires_at: result.apexExpiresAt?.toISOString(),
    }, 'WHOIS info refreshed successfully');
  } else {
    sendError(res, result.message || 'Failed to refresh WHOIS info');
  }
}));

/**
 * Renew a domain — generic route using RenewalScheduler registry
 */
router.post('/:id/renew', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const renewableDomainId = parseInteger(req.params.id);

  log.info('Renewal request received', { renewableDomainId, userId: req.user?.userId });

  if (!renewableDomainId) {
    sendError(res, 'Missing domain ID');
    return;
  }

  const role = normalizeRole(req.user?.role);
  if (role < 2) {
    log.warn('Unauthorized renewal attempt', { userId: req.user?.userId, role });
    sendError(res, 'Permission denied');
    return;
  }

  const renewableDomain = await RenewableDomainOperations.getById(renewableDomainId);
  if (!renewableDomain) {
    sendError(res, 'Renewable domain not found');
    return;
  }

  if (!renewableDomain.enabled) {
    sendError(res, 'Cannot renew disabled domain. Please enable it first.');
    return;
  }

  const account = await DnsAccountOperations.getById(renewableDomain.account_id) as DnsAccount | undefined;
  if (!account) {
    sendError(res, 'Account not found');
    return;
  }

  log.info('Renewal — account', { accountId: account.id, type: account.type, domain: renewableDomain.full_domain });

  const scheduler = renewalRegistry.getScheduler(account.type);
  if (!scheduler) {
    log.warn('No renewal scheduler for provider type', { type: account.type });
    sendError(res, 'Renewal not supported for this provider');
    return;
  }

  const config = typeof account.config === 'string' ? JSON.parse(account.config) : account.config;
  const domainId = renewableDomain.third_id || renewableDomain.id;

  try {
    const result = await scheduler.renewDomain(config, domainId);

    if (!result.success) {
      sendError(res, result.message || 'Renewal failed');
      return;
    }

    // Update expires_at
    if (result.new_expires_at) {
      await RenewableDomainOperations.updateExpiresAt(renewableDomainId, result.new_expires_at);
    }

    // Log audit
    await logAuditOperation(req.user!.userId, 'renew_domain', renewableDomain.full_domain, result, req);

    // WebSocket
    try {
      wsService.broadcast({
        type: 'domain_renewed',
        data: {
          renewableDomainId,
          fullDomain: renewableDomain.full_domain,
          newExpiresAt: result.new_expires_at,
        },
      });
    } catch (error) {
      log.error('Failed to broadcast domain_renewed event', { error });
    }

    sendSuccess(res, result, 'Domain renewed successfully');
  } catch (error) {
    log.error('Renewal failed', { error: error instanceof Error ? error.message : String(error) });
    sendError(res, error instanceof Error ? error.message : 'Renewal failed');
  }
}));

/**
 * Get WHOIS information for a domain (DNSHE only)
 */
router.get('/whois', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const { domain, accountId } = req.query;

  if (!domain || typeof domain !== 'string') {
    sendError(res, 'Domain parameter is required');
    return;
  }

  // Normalize domain name to Punycode for database query
  const normalizedDomain = normalizeDomain(domain);

  let dbDomain: Domain | undefined;

  if (accountId) {
    // 如果指定了 accountId，精确查询
    dbDomain = await DomainOperations.getByAccountIdAndName(
      Number(accountId),
      normalizedDomain
    ) as Domain | undefined;

    if (!dbDomain) {
      sendError(res, 'Domain not found in specified account');
      return;
    }
  } else {
    // 未指定 accountId，查询第一条记录
    dbDomain = await DomainOperations.getByName(normalizedDomain) as Domain | undefined;

    if (!dbDomain) {
      sendError(res, 'Domain not found');
      return;
    }

    // 检查用户是否有权限访问这个域名
    const access = await resolveDomainAccessById(dbDomain.id, req.user!.userId, normalizeRole(req.user?.role));

    if (!access.domain || !access.canRead) {
      // 如果第一条记录无权限，尝试查找用户有权限的其他同名域名
      const userDomains = await DomainOperations.getAll() as unknown as Domain[];
      const accessibleDomains = userDomains.filter((d: Domain) => d.name === normalizedDomain);

      let foundAccessible = false;
      for (const candidateDomain of accessibleDomains) {
        const candidateAccess = await resolveDomainAccessById(
          candidateDomain.id,
          req.user!.userId,
          normalizeRole(req.user?.role)
        );

        if (candidateAccess.domain && candidateAccess.canRead) {
          dbDomain = candidateDomain;
          foundAccessible = true;
          break;
        }
      }

      if (!foundAccessible) {
        sendError(res, 'No permission to access this domain');
        return;
      }
    }
  }

  // Get the account
  const account = await DnsAccountOperations.getById(dbDomain.account_id) as DnsAccount | undefined;
  if (!account) {
    sendError(res, 'Account not found');
    return;
  }

  try {
    // 使用通用 WHOIS 查询服务（支持所有域名）
    log.info(`Querying WHOIS for ${domain}`);
    const whoisResult = await queryWhois(domain);

    if (!whoisResult) {
      sendError(res, 'WHOIS query failed or no data available');
      return;
    }

    // 转换为前端期望的格式
    const response = {
      domain: whoisResult.domain || domain,
      status: whoisResult.raw ? extractWhoisStatus(whoisResult.raw) : null,
      registrar: whoisResult.registrar || null,
      expires_at: whoisResult.expiryDate ? whoisResult.expiryDate.toISOString() : null,
      created_date: null,
      updated_date: null,
      name_servers: whoisResult.nameServers || [],
      raw_data: whoisResult.raw || '',
    };

    sendSuccess(res, response);
  } catch (error) {
    log.error('WHOIS query failed', { error });
    sendError(res, error instanceof Error ? error.message : 'WHOIS query failed');
  }
}));

/**
 * 从 WHOIS 原始数据中提取状态
 */
function extractWhoisStatus(rawData: string): string | null {
  const statusMatch = rawData.match(/status:\s*(.+)/i);
  if (statusMatch && statusMatch[1]) {
    return statusMatch[1].trim().split('\n')[0].trim();
  }
  return null;
}

/**
 * Add a domain to renewable list (admin only)
 */
router.post('/renewable-domains', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  // Only allow admins and super admins
  const role = normalizeRole(req.user?.role);
  if (role < 2) {
    log.warn('Unauthorized attempt to add renewable domain', { userId: req.user?.userId, role });
    sendError(res, 'Permission denied');
    return;
  }

  const { account_id, provider_type, domain_name, third_id, full_domain, expires_at, remark } = req.body as {
    account_id: number;
    provider_type: string;
    domain_name: string;
    third_id: string;
    full_domain: string;
    expires_at?: string;
    remark?: string;
  };

  log.info('Add renewable domain request', {
    account_id,
    provider_type,
    domain_name,
    third_id,
    full_domain,
    expires_at,
    userId: req.user?.userId
  });

  if (!account_id || !provider_type || !domain_name || !third_id || !full_domain) {
    log.error('Missing required fields for adding renewable domain', {
      account_id,
      provider_type,
      domain_name,
      third_id,
      full_domain
    });
    sendError(res, 'Missing required fields');
    return;
  }

  try {
    log.debug('Adding renewable domain to database', { account_id, provider_type, domain_name, third_id });

    const id = await RenewableDomainOperations.add({
      account_id,
      provider_type,
      domain_name,
      third_id,
      full_domain,
      expires_at,
      remark,
    });

    log.info('Successfully added renewable domain', { id, full_domain, userId: req.user?.userId });
    sendSuccess(res, { id });
  } catch (error) {
    log.error('Failed to add renewable domain', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    sendError(res, 'Failed to add renewable domain');
  }
}));

/**
 * Delete a domain from renewable list (admin only)
 */
router.delete('/renewable-domains/:id', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  // Only allow admins and super admins
  const role = normalizeRole(req.user?.role);
  if (role < 2) {
    log.warn('Unauthorized attempt to delete renewable domain', { userId: req.user?.userId, role });
    sendError(res, 'Permission denied');
    return;
  }

  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    log.error('Invalid renewable domain ID', { id: req.params.id });
    sendError(res, 'Invalid ID');
    return;
  }

  log.info('Delete renewable domain request', { id, userId: req.user?.userId });

  try {
    await RenewableDomainOperations.delete(id);
    log.info('Successfully deleted renewable domain', { id, userId: req.user?.userId });
    sendSuccess(res, null);
  } catch (error) {
    log.error('Failed to delete renewable domain', {
      id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    sendError(res, 'Failed to delete renewable domain');
  }
}));

/**
 * Toggle renewable domain enabled status
 */
router.patch('/renewable-domains/:id/toggle-enabled', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  // Only allow admins and super admins
  const role = normalizeRole(req.user?.role);
  if (role < 2) {
    log.warn('Unauthorized attempt to toggle renewable domain', { userId: req.user?.userId, role });
    sendError(res, 'Permission denied');
    return;
  }

  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    log.error('Invalid renewable domain ID', { id: req.params.id });
    sendError(res, 'Invalid ID');
    return;
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    log.error('Missing or invalid enabled field', { enabled });
    sendError(res, 'Enabled field is required and must be boolean');
    return;
  }

  log.info('Toggle renewable domain enabled status', {
    id,
    enabled,
    userId: req.user?.userId
  });

  try {
    // Get current domain info for audit log
    const domain = await RenewableDomainOperations.getById(id);
    if (!domain) {
      log.error('Renewable domain not found', { id });
      sendError(res, 'Renewable domain not found');
      return;
    }

    await RenewableDomainOperations.toggleEnabled(id, enabled);

    // Log audit operation
    await logAuditOperation(
      req.user!.userId,
      enabled ? 'enable_domain_renewal' : 'disable_domain_renewal',
      domain.full_domain,
      { enabled },
      req
    );

    log.info('Successfully toggled renewable domain enabled status', {
      id,
      enabled,
      userId: req.user?.userId
    });

    sendSuccess(res, { enabled });
  } catch (error) {
    log.error('Failed to toggle renewable domain enabled status', {
      id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    sendError(res, 'Failed to update enabled status');
  }
}));

/**
 * Sync domains from provider to renewable list (admin only)
 */
router.post('/renewable-domains/sync', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  // Only allow admins and super admins
  const role = normalizeRole(req.user?.role);
  if (role < 2) {
    sendError(res, 'Permission denied');
    return;
  }

  const { account_id, domain_ids } = req.body as {
    account_id: number;
    domain_ids: Array<{
      id: string | number;
      full_domain: string;
      name?: string;
      expires_at?: string;
    }>;
  };

  if (!account_id || !Array.isArray(domain_ids) || domain_ids.length === 0) {
    sendError(res, 'Missing required fields');
    return;
  }

  try {
    // Get account info
    const account = await DnsAccountOperations.getById(account_id);
    if (!account) {
      sendError(res, 'Account not found');
      return;
    }

    // Filter out disabled domains
    const enabledDomainIds: Set<string> = new Set();
    for (const d of domain_ids) {
      const dbDomain = await DomainOperations.getByAccountIdAndName(account_id, d.name || d.full_domain.split('.')[0]);
      if (dbDomain && dbDomain.enabled !== 0) {
        enabledDomainIds.add(String(d.id));
      } else if (dbDomain) {
        log.info(`Skipping disabled domain for renewal sync: ${d.name || d.full_domain}`);
      }
    }

    // Add only enabled domains to renewable list
    const domainsToAdd = domain_ids
      .filter(d => enabledDomainIds.has(String(d.id)))
      .map(d => ({
        account_id,
        provider_type: String(account.type),
        domain_name: d.name || d.full_domain.split('.')[0],
        third_id: String(d.id),
        full_domain: d.full_domain,
        expires_at: d.expires_at,
        remark: `Synced from ${account.name}`,
      }));

    const addedCount = await RenewableDomainOperations.addBatch(domainsToAdd);

    log.info('Synced renewable domains', {
      accountId: account_id,
      addedCount,
      totalCount: domain_ids.length
    });

    sendSuccess(res, { addedCount, total: domain_ids.length });
  } catch (error) {
    log.error('Failed to sync renewable domains', { error });
    sendError(res, 'Failed to sync domains');
  }
}));

export { canAccessDomain, getAccountForUser };
export default router;
