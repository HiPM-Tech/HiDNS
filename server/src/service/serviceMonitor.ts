import https from 'https';
import http from 'http';
import tls from 'tls';
import { ServiceMonitorOperations, DomainOperations, DnsAccountOperations, getDbType } from '../db/bal/business-adapter';
import { dnsResolver } from '../lib/dns/resolver';
import { createLogger } from '../lib/logger';
import { DnsProviderService } from './dns-provider-service';
import { sendNotification } from './notification';
import { checkWhoisForDomain } from './whois/checker';

const log = createLogger('Service').sub('ServiceMonitor');

export interface ServiceMonitorMonitor {
  id: number;
  userId: number;
  name: string;
  type: 'ssl_certificate' | 'endpoint' | 'dns_failover';
  target: string;
  domainId: number | null;
  parentId: number | null;
  config: Record<string, unknown>;
  checkInterval: number;
  checkTimeout: number;
  enabled: boolean;
  notifyOnFailure: boolean;
  notifyOnRecovery: boolean;
  createdAt: string;
  updatedAt: string;
  status?: ServiceMonitorStatus;
}

export interface ServiceMonitorStatus {
  id: number;
  monitorId: number;
  status: 'ok' | 'warning' | 'error' | 'unknown';
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  lastResponseTime: number | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  resultData: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

// ---- SSL Certificate Config & Result types ----

export interface SSLCertConfig {
  /** 允许内网目标（需管理员创建；元数据地址仍拒绝） */
  allowPrivate?: boolean;
  port?: number;
  warn_days_before?: number;
  check_chain?: boolean;
}

export interface SSLCertResult extends Record<string, unknown> {
  encryptionType: string;
  subjectCn: string;
  sanDomains: string[];
  issuer: string;
  validationLevel: string;
  validFrom: string;
  validTo: string;
  daysLeft: number;
  fingerprint?: string;
  serialNumber?: string;
}

// ---- Endpoint Config & Result types ----

export interface EndpointConfig {
  /** 允许内网目标（需管理员创建；元数据地址仍拒绝） */
  allowPrivate?: boolean;
  protocol?: 'http' | 'https';
  port?: number;
  path?: string;
  followRedirects?: boolean;
  method?: string;
  expectedStatus?: number;
  expectedBody?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface EndpointResult extends Record<string, unknown> {
  finalUrl: string;
  statusCode: number;
  statusMessage: string;
  responseTime: number;
  redirectCount: number;
  headers: Record<string, string>;
  bodyPreview?: string;
}

// ---- DNS Failover Config & Result types ----

export interface DnsFailoverConfig {
  recordType: 'A' | 'AAAA' | 'CNAME';
  recordName: string;
  ttl: number;
  line: string;
  proxyEnabled: boolean;
  primaryValue: string;
  backupValues: string[];
  checkMethod?: 'http' | 'tcp' | 'ping';
  checkPort?: number;
  checkPath?: string;
  autoSwitchBack?: boolean;
  /** 允许指向内网/保留地址（自建内网 DNS 场景；需管理员创建，禁元数据地址） */
  allowPrivate?: boolean;
}

export interface DnsFailoverResult extends Record<string, unknown> {
  activeValue: string;
  switchedAt: string;
  usingBackup: boolean;
  previousValue?: string;
  recordId?: string;
}

// ---- Public API ----

export async function getMonitors(userId: number): Promise<(ServiceMonitorMonitor & { status?: ServiceMonitorStatus })[]> {
  const rows = await ServiceMonitorOperations.getByUser(userId) as any[];
  const monitors: (ServiceMonitorMonitor & { status?: ServiceMonitorStatus })[] = [];

  for (const row of rows) {
    const monitor = rowToMonitor(row);
    const statusRow = await ServiceMonitorOperations.getStatus(monitor.id) as any;
    if (statusRow) {
      monitor.status = rowToStatus(statusRow);
    }
    monitors.push(monitor);
  }

  return monitors;
}

export async function getMonitorsWithPagination(userId: number, page: number, pageSize: number, type?: string, keyword?: string): Promise<{ monitors: (ServiceMonitorMonitor & { status?: ServiceMonitorStatus })[]; total: number }> {
  const { list: rows, total } = await ServiceMonitorOperations.getByUserWithPagination(userId, page, pageSize, type, keyword) as any;
  const monitors: (ServiceMonitorMonitor & { status?: ServiceMonitorStatus })[] = [];

  for (const row of rows) {
    const monitor = rowToMonitor(row);
    const statusRow = await ServiceMonitorOperations.getStatus(monitor.id) as any;
    if (statusRow) {
      monitor.status = rowToStatus(statusRow);
    }
    monitors.push(monitor);
  }

  return { monitors, total };
}

export async function getMonitor(id: number): Promise<(ServiceMonitorMonitor & { status?: ServiceMonitorStatus }) | null> {
  const row = await ServiceMonitorOperations.getById(id) as any;
  if (!row) return null;

  const monitor = rowToMonitor(row);
  const statusRow = await ServiceMonitorOperations.getStatus(monitor.id) as any;
  if (statusRow) {
    monitor.status = rowToStatus(statusRow);
  }
  return monitor;
}

export async function getMonitorsByParentId(parentId: number): Promise<ServiceMonitorMonitor[]> {
  const rows = await ServiceMonitorOperations.getByParentId(parentId) as any[];
  return rows.map(rowToMonitor);
}

export async function createMonitor(data: {
  userId: number;
  name: string;
  type: string;
  target: string;
  domainId?: number;
  parentId?: number;
  config: Record<string, unknown>;
  checkInterval?: number;
  checkTimeout?: number;
  enabled?: boolean;
  notifyOnFailure?: boolean;
  notifyOnRecovery?: boolean;
}): Promise<number> {
  const insertData: Record<string, unknown> = {
    user_id: data.userId,
    name: data.name,
    type: data.type,
    target: data.target,
    config: JSON.stringify(data.config),
    check_interval: data.checkInterval || 300,
    check_timeout: data.checkTimeout || 10,
    enabled: data.enabled !== false ? 1 : 0,
    notify_on_failure: data.notifyOnFailure !== false ? 1 : 0,
    notify_on_recovery: data.notifyOnRecovery !== false ? 1 : 0,
  };

  if (data.domainId !== undefined) {
    insertData.domain_id = data.domainId;
  }
  if (data.parentId !== undefined) {
    insertData.parent_id = data.parentId;
  }

  const id = await ServiceMonitorOperations.create(insertData);
  await ServiceMonitorOperations.initStatus(id);

  return id;
}

export async function updateMonitor(id: number, data: Partial<{
  name: string;
  type: string;
  target: string;
  domainId: number | null;
  parentId: number | null;
  config: Record<string, unknown>;
  checkInterval: number;
  checkTimeout: number;
  enabled: boolean;
  notifyOnFailure: boolean;
  notifyOnRecovery: boolean;
}>): Promise<void> {
  const updates: Record<string, unknown> = {};

  if (data.name !== undefined) updates.name = data.name;
  if (data.type !== undefined) updates.type = data.type;
  if (data.target !== undefined) updates.target = data.target;
  if (data.domainId !== undefined) updates.domain_id = data.domainId;
  if (data.parentId !== undefined) updates.parent_id = data.parentId;
  if (data.config !== undefined) updates.config = JSON.stringify(data.config);
  if (data.checkInterval !== undefined) updates.check_interval = data.checkInterval;
  if (data.checkTimeout !== undefined) updates.check_timeout = data.checkTimeout;
  if (data.enabled !== undefined) updates.enabled = data.enabled ? 1 : 0;
  if (data.notifyOnFailure !== undefined) updates.notify_on_failure = data.notifyOnFailure ? 1 : 0;
  if (data.notifyOnRecovery !== undefined) updates.notify_on_recovery = data.notifyOnRecovery ? 1 : 0;

  if (Object.keys(updates).length > 0) {
    await ServiceMonitorOperations.update(id, updates);
  }
}

export async function deleteMonitor(id: number): Promise<void> {
  await ServiceMonitorOperations.delete(id);
}

export async function getAllEnabled(): Promise<ServiceMonitorMonitor[]> {
  const rows = await ServiceMonitorOperations.getAllEnabled() as any[];
  return rows.map(rowToMonitor);
}

// ---- DNS Resolver helper ----

async function resolveDomainWithFallback(domain: string): Promise<{ ips: string[]; source: string } | { error: string }> {
  try {
    const result = await dnsResolver.resolve(domain, 1, { preferEncrypted: true });
    if (result.success && result.records && result.records.length > 0) {
      return { ips: result.records.map(r => r.data), source: result.source };
    }
    log.warn(`DNS resolve returned no records for ${domain}`, { source: result.source });
    return { error: `No DNS records found for ${domain}` };
  } catch (err: any) {
    log.error(`DNS resolve error for ${domain}`, { error: err.message });
    return { error: `DNS resolve failed: ${err.message}` };
  }
}

// ---- SSL Certificate Check ----

export async function checkSSL(
  target: string,
  config: SSLCertConfig
): Promise<{
  status: 'ok' | 'warning' | 'error';
  responseTime: number | null;
  error: string | null;
  resultData: SSLCertResult | null;
}> {
  const startTime = Date.now();
  const port = config.port || 443;
  const warnDays = config.warn_days_before || 30;

  // TLS 直连同样是出口：不校验就会变成「任意 host:port 的内网端口扫描 oracle」
  // （渗透测试第二轮实测 127.0.0.1:3999 能通过 wrong version number / ECONNREFUSED 区分端口状态）。
  const sslGuard = await guardTarget(target, config.allowPrivate);
  if (!sslGuard.ok) {
    return { status: 'error', responseTime: Date.now() - startTime, error: sslGuard.reason, resultData: null };
  }

  // Step 1: DNS resolve via HiDNS internal resolver
  const resolved = await resolveDomainWithFallback(target);
  if ('error' in resolved) {
    return { status: 'error', responseTime: Date.now() - startTime, error: resolved.error, resultData: null };
  }

  // Step 2: Connect and fetch certificate
  return new Promise((resolve) => {
    const socket = tls.connect(port, target, { rejectUnauthorized: false, servername: target }, () => {
      const cert = socket.getPeerCertificate(true);
      const responseTime = Date.now() - startTime;

      if (!cert || !cert.valid_to) {
        socket.destroy();
        resolve({ status: 'error', responseTime, error: 'Could not retrieve SSL certificate', resultData: null });
        return;
      }

      // Parse encryption type
      let encryptionType = 'Unknown';
      const bits = cert.bits || 0;
      if (bits >= 2048) encryptionType = `RSA ${bits}`;
      else if (bits >= 384) encryptionType = `EC ${bits}`;
      else if (bits >= 256) encryptionType = `EC 256`;
      else if (bits > 0) encryptionType = `RSA ${bits}`;

      // Determine validation level from certificate policies or issuer
      let validationLevel = 'DV';
      const issuerStr = JSON.stringify(cert.issuer || {});
      const subjectStr = JSON.stringify(cert.subject || {});

      // OV: issuer/cert contains organization info
      // EV: extended validation - look for jurisdiction/businessCategory
      if (issuerStr.includes('jurisdiction') || subjectStr.includes('businessCategory') ||
          issuerStr.includes('organizationIdentifier')) {
        validationLevel = 'EV';
      } else if ((cert.issuer?.O && cert.subject?.O) || issuerStr.includes('organizationName')) {
        validationLevel = 'OV';
      }

      // Parse SAN domains
      const san = cert.subjectaltname || '';
      const sanDomains: string[] = [];
      if (san) {
        san.split(', ').forEach(entry => {
          const idx = entry.indexOf(':');
          if (idx >= 0) {
            sanDomains.push(entry.substring(idx + 1));
          }
        });
      }

      const issuerName = String(cert.issuer?.O || cert.issuer?.CN || 'Unknown');

      const resultData: SSLCertResult = {
        encryptionType,
        subjectCn: String(cert.subject?.CN || ''),
        sanDomains,
        issuer: issuerName,
        validationLevel,
        validFrom: cert.valid_from,
        validTo: cert.valid_to,
        daysLeft: Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
        fingerprint: cert.fingerprint,
        serialNumber: cert.serialNumber,
      };

      socket.destroy();

      const daysLeft = resultData.daysLeft;
      if (daysLeft <= 0) {
        resolve({ status: 'error', responseTime, error: `SSL certificate expired on ${cert.valid_to}`, resultData });
      } else if (daysLeft <= warnDays) {
        resolve({ status: 'warning', responseTime, error: `SSL expires in ${daysLeft} days`, resultData });
      } else {
        resolve({ status: 'ok', responseTime, error: null, resultData });
      }
    });

    const timeout = Math.max(config.port ? 10000 : 10000, 5000);
    socket.setTimeout(timeout, () => {
      socket.destroy();
      resolve({ status: 'error', responseTime: Date.now() - startTime, error: 'SSL check timed out', resultData: null });
    });

    socket.on('error', (err) => {
      resolve({ status: 'error', responseTime: Date.now() - startTime, error: `SSL check failed: ${err.message}`, resultData: null });
    });
  });
}

// ---- Endpoint Check ----

export async function checkEndpoint(
  target: string,
  config: EndpointConfig
): Promise<{
  status: 'ok' | 'warning' | 'error';
  responseTime: number | null;
  error: string | null;
  resultData: EndpointResult | null;
}> {
  const startTime = Date.now();
  // 目标必须是公网：既挡「解析到内网的域名」，也挡直接写 IP
  const targetGuard = await guardTarget(target, config.allowPrivate);
  if (!targetGuard.ok) {
    return { status: 'error', responseTime: null, error: targetGuard.reason, resultData: null };
  }
  const protocol = config.protocol || 'https';
  const port = config.port || (protocol === 'https' ? 443 : 80);
  const path = config.path || '/';
  const followRedirects = config.followRedirects !== false;
  const method = config.method || 'GET';

  // Step 1: DNS resolve via HiDNS internal resolver
  const resolved = await resolveDomainWithFallback(target);
  if ('error' in resolved) {
    return { status: 'error', responseTime: Date.now() - startTime, error: resolved.error, resultData: null };
  }

  const url = `${protocol}://${target}:${port}${path}`;

  return new Promise((resolve) => {
    let redirectCount = 0;
    const MAX_REDIRECTS = 5;

    function doRequest(currentUrl: string): void {
      const parsedUrl = new URL(currentUrl);
      const opts: https.RequestOptions | http.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (protocol === 'https' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: { ...(config.headers || {}), 'User-Agent': 'HiDNS-Monitor/1.0' },
        timeout: 10000,
        rejectUnauthorized: false,
      };

      const lib = parsedUrl.protocol === 'https:' ? https : http;
      const req = lib.request(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          const responseTime = Date.now() - startTime;
          const statusCode = res.statusCode || 0;

          // Handle redirects
          if (followRedirects && statusCode >= 300 && statusCode < 400 && res.headers.location) {
            if (redirectCount < MAX_REDIRECTS) {
              redirectCount++;
              const redirectUrl = new URL(res.headers.location, currentUrl).href;
              // 每一跳都要复核：公网 302 指向 169.254.169.254 就是完整 SSRF 绕过。
              // 注意只取 hostname——之前把整条 URL 传给只接受 hostname 的函数，
              // 导致所有跳转都被判「目标无法解析」，followRedirects 直接失效。
              const redirectHost = new URL(redirectUrl).hostname.replace(/^\[|\]$/g, '');
              void resolvePublicTarget(redirectHost).then((guard) => {
                if (!guard.ok) {
                  resolve({ status: 'error', responseTime, error: '重定向目标被拒绝: ' + guard.reason, resultData: null });
                  return;
                }
                doRequest(redirectUrl);
              });
              return;
            }
            resolve({
              status: 'error', responseTime,
              error: `Too many redirects (${MAX_REDIRECTS})`,
              resultData: {
                finalUrl: currentUrl, statusCode, statusMessage: res.statusMessage || '',
                responseTime, redirectCount, headers: res.headers as Record<string, string>, bodyPreview: body.substring(0, 500),
              },
            });
            return;
          }

          const expectedStatus = config.expectedStatus || 200;
          let endpointStatus: 'ok' | 'warning' | 'error' = 'ok';
          let error: string | null = null;

          if (statusCode >= 500) {
            endpointStatus = 'error';
            error = `Server error: ${statusCode}`;
          } else if (statusCode >= 400) {
            endpointStatus = 'error';
            error = `Client error: ${statusCode}`;
          } else if (statusCode >= 300) {
            endpointStatus = 'ok';
          } else if (statusCode !== expectedStatus && expectedStatus) {
            endpointStatus = 'warning';
            error = `Expected ${expectedStatus}, got ${statusCode}`;
          }

          if (!error && config.expectedBody && !body.includes(config.expectedBody)) {
            endpointStatus = 'error';
            error = 'Response body does not contain expected text';
          }

          resolve({
            status: endpointStatus, responseTime, error,
            resultData: {
              finalUrl: currentUrl, statusCode, statusMessage: res.statusMessage || '',
              responseTime, redirectCount, headers: res.headers as Record<string, string>, bodyPreview: body.substring(0, 500),
            },
          });
        });
      });

      req.on('timeout', () => { req.destroy(); resolve({ status: 'error', responseTime: Date.now() - startTime, error: 'Request timed out', resultData: null }); });
      req.on('error', (err) => { resolve({ status: 'error', responseTime: Date.now() - startTime, error: `Request failed: ${err.message}`, resultData: null }); });

      if (config.body && method !== 'GET' && method !== 'HEAD') {
        req.write(config.body);
      }
      req.end();
    }

    doRequest(url);
  });
}

// ---- DNS Failover ----

const FAILOVER_STATE: Record<number, { usingBackup: boolean; lastSwitchTime: number }> = {};

export async function checkFailover(
  monitor: ServiceMonitorMonitor
): Promise<{
  status: 'ok' | 'warning' | 'error';
  responseTime: number | null;
  error: string | null;
  resultData: DnsFailoverResult | null;
}> {
  const config = monitor.config as unknown as DnsFailoverConfig;
  const startTime = Date.now();
  const domainName = monitor.target;
  const failoverDomainId = monitor.domainId;

  // Step 0: Skip if domain or account is disabled
  if (failoverDomainId) {
    try {
      const domainInfo = await DomainOperations.getById(failoverDomainId) as any;
      if (domainInfo) {
        if (domainInfo.enabled === 0 || domainInfo.enabled === false) {
          return { status: 'warning', responseTime: null, error: `Domain ${domainInfo.name} is disabled, failover skipped`, resultData: null };
        }
        const accountInfo = await DnsAccountOperations.getById(domainInfo.account_id) as any;
        if (accountInfo && (accountInfo.enabled === 0 || accountInfo.enabled === false)) {
          return { status: 'warning', responseTime: null, error: `Account ${accountInfo.name} is disabled, failover skipped`, resultData: null };
        }
      }
    } catch (e) {
      log.warn('Failed to check domain/account status during failover, continuing', { error: e, monitorId: monitor.id });
    }
  }

  // Step 0: 出口校验（failover 的 http 探测同样是 SSRF 出口）
  const failoverGuard = await guardTarget(config.primaryValue, config.allowPrivate);
  if (!failoverGuard.ok) {
    return { status: 'error', responseTime: Date.now() - startTime, error: failoverGuard.reason, resultData: null };
  }

  // Step 1: DNS resolve primary value（IP 字面量跳过：故障转移最常见的配置就是填 IP）
  const net = require('node:net') as typeof import('node:net');
  if (!net.isIP(config.primaryValue)) {
    const resolved = await resolveDomainWithFallback(config.primaryValue);
    if ('error' in resolved) {
      return { status: 'error', responseTime: Date.now() - startTime, error: `Primary target resolve failed: ${resolved.error}`, resultData: null };
    }
  }

  // Step 2: Check primary reachability
  const primaryAvailable = await checkIpAvailabilitySimple(config.primaryValue, config.checkMethod || 'tcp', config.checkPort || 80, config.checkPath || '/');

  // Step 3: If primary is available and we're on primary, all good
  const state = FAILOVER_STATE[monitor.id] || { usingBackup: false, lastSwitchTime: 0 };

  if (primaryAvailable && !state.usingBackup) {
    return { status: 'ok', responseTime: Date.now() - startTime, error: null, resultData: { activeValue: config.primaryValue, switchedAt: new Date().toISOString(), usingBackup: false } };
  }

  // Step 4: Primary unavailable — attempt failover
  if (!primaryAvailable) {
    // Check WHOIS status for the bound domain (only for apex)
    if (failoverDomainId) {
      try {
        const domainInfo = await DomainOperations.getById(failoverDomainId) as any;
        if (domainInfo) {
          const whoisResult = await checkWhoisForDomain(domainInfo.name, false);
          if (whoisResult && whoisResult.status === 'hold') {
            return { status: 'error', responseTime: Date.now() - startTime, error: `Domain ${domainInfo.name} is on HOLD, failover aborted`, resultData: null };
          }
        }
      } catch (whoisErr) {
        log.warn('WHOIS check failed during failover, continuing', { error: whoisErr, monitorId: monitor.id });
      }
    }

    // Try backup values
    for (const backupValue of config.backupValues) {
      if (!backupValue.trim()) continue;
      const backupAvailable = await checkIpAvailabilitySimple(backupValue.trim(), config.checkMethod || 'tcp', config.checkPort || 80, config.checkPath || '/');
      if (backupAvailable) {
        // Update DNS record on the provider
        if (failoverDomainId && config.recordName !== undefined) {
          try {
            await updateFailoverDnsRecord(failoverDomainId, config, backupValue.trim());
          } catch (dnsErr: any) {
            log.error('Failed to update DNS record for failover', { error: dnsErr, monitorId: monitor.id });
          }
        }

        FAILOVER_STATE[monitor.id] = { usingBackup: true, lastSwitchTime: Date.now() };

        return {
          status: 'warning', responseTime: Date.now() - startTime,
          error: `Primary unavailable, switched to backup: ${backupValue.trim()}`,
          resultData: { activeValue: backupValue.trim(), switchedAt: new Date().toISOString(), usingBackup: true, previousValue: config.primaryValue },
        };
      }
    }

    return { status: 'error', responseTime: Date.now() - startTime, error: 'Primary and all backups unavailable', resultData: null };
  }

  // Step 5: Primary is back and we're on backup — auto switch back
  if (primaryAvailable && state.usingBackup && config.autoSwitchBack !== false) {
    if (failoverDomainId && config.recordName !== undefined) {
      try {
        await updateFailoverDnsRecord(failoverDomainId, config, config.primaryValue);
      } catch (dnsErr: any) {
        log.error('Failed to restore primary DNS record', { error: dnsErr, monitorId: monitor.id });
      }
    }

    FAILOVER_STATE[monitor.id] = { usingBackup: false, lastSwitchTime: Date.now() };

    return {
      status: 'ok', responseTime: Date.now() - startTime, error: null,
      resultData: { activeValue: config.primaryValue, switchedAt: new Date().toISOString(), usingBackup: false },
    };
  }

  return { status: 'ok', responseTime: Date.now() - startTime, error: null, resultData: { activeValue: config.primaryValue, switchedAt: new Date().toISOString(), usingBackup: state.usingBackup } };
}

async function updateFailoverDnsRecord(domainId: number, config: DnsFailoverConfig, value: string): Promise<void> {
  try {
    const domain = await DomainOperations.getById(domainId) as any;
    if (!domain) throw new Error(`Domain ${domainId} not found`);

    const account = await DnsAccountOperations.getById(domain.account_id) as any;
    if (!account) throw new Error(`Account for domain ${domainId} not found`);
    if (account.enabled !== 1 && account.enabled !== true) throw new Error(`Account ${account.id} is disabled`);
    if (domain.enabled !== 1 && domain.enabled !== true) throw new Error(`Domain ${domain.name} is disabled`);

    // Find existing record
    const records = await DnsProviderService.getRecords(domainId, { keyword: config.recordName, type: config.recordType });
    const existing = (records.list || []).find((r: any) =>
      r.Name === config.recordName && r.Type === config.recordType
    );

    if (existing) {
      await DnsProviderService.updateRecord(existing.RecordId, domainId, config.recordName, config.recordType, value, {
        line: config.line || 'default', ttl: config.ttl || 600,
      });
      log.info(`Failover: updated record ${config.recordName} -> ${value}`, { domainId, recordId: existing.RecordId });
    } else {
      await DnsProviderService.createRecord(domainId, config.recordName, config.recordType, value, {
        line: config.line || 'default', ttl: config.ttl || 600,
      });
      log.info(`Failover: created record ${config.recordName} -> ${value}`, { domainId });
    }
  } catch (err: any) {
    log.error('updateFailoverDnsRecord failed', { error: err.message, domainId });
    throw err;
  }
}

/**
 * 目标出口守卫。
 *
 * 默认只允许公网；监控配置里显式 allowPrivate=true（且由管理员创建）时放行内网，
 * 但**元数据地址永远拒绝**（169.254.169.254 / fd00:ec2::254 这类云凭据端点）。
 */
async function guardTarget(target: string, allowPrivate?: boolean): Promise<{ ok: true } | { ok: false; reason: string }> {
  const net = require('node:net') as typeof import('node:net');
  const privateResult = net.isIP(target)
    ? (isPrivateAddress(target) ? { ok: false as const, reason: '目标不允许指向内网/保留地址' } : { ok: true as const })
    : null;
  const result = privateResult ?? await resolvePublicTarget(target);
  if (result.ok) return result;
  if (allowPrivate && !isMetadataAddress(target)) return { ok: true };
  return result;
}

/** 云元数据地址：任何情况下都不允许探测 */
function isMetadataAddress(target: string): boolean {
  return /^(169\.254\.169\.254|fd00:ec2::254)$/i.test(target.trim());
}

/**
 * 健康检查路径白名单。
 *
 * 路径来自监控配置，若直接拼进 `http://host:port${path}`，
 * `@127.0.0.1:3999/x` 这类 userinfo 写法会把 host 改写掉（第六轮实测可探测内网）。
 * 这里强制「以 / 开头、不含 @ \ 空白与控制字符」，否则回落为 '/'。
 */
export function sanitizeCheckPath(path: unknown): string {
  const raw = String(path ?? '/').trim();
  return /^\/[^@\\\s\u0000-\u001f]*$/.test(raw) ? raw : '/';
}

/**
 * 私有/保留地址判定（**只接受 IP 字面量**）。
 * 非 IP 输入返回 false —— 之前兜底 return true 会把 example.com 也判成内网，
 * 导致 endpoint 监控对所有域名失效（第二轮回归发现的功能回归）。
 */
export function isPrivateAddress(address: string): boolean {
  const net = require('node:net') as typeof import('node:net');
  const version = net.isIP(address);
  if (version === 0) return false;
  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;   // link-local / 云元数据
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;                  // multicast / reserved
    return false;
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80')) return true;  // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA

    // IPv4 映射地址有两种写法：::ffff:127.0.0.1（点分）与 ::ffff:7f00:1（十六进制）。
    // 只处理点分会漏掉后者，而 net.connect / tls.connect 都接受它并直连内网
    // （第三轮实测 ::ffff:7f00:1 可连到 127.0.0.1 的监听端口）。
    if (lower.startsWith('::ffff:')) {
      const rest = lower.slice('::ffff:'.length);
      if (rest.includes('.')) return isPrivateAddress(rest);
      const groups = rest.split(':');
      if (groups.length === 2) {
        const hi = parseInt(groups[0], 16);
        const lo = parseInt(groups[1], 16);
        if (Number.isFinite(hi) && Number.isFinite(lo)) {
          const v4 = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
          return isPrivateAddress(v4);
        }
      }
      return true; // 形态不认识的映射地址：按私有处理（fail-closed）
    }
    return false;
  }
  // 非 IP（version === 0）在上面已返回 false
  return false;
}

/**
 * 解析目标并确认全部地址都是公网：服务监控的 target 由普通用户填写，
 * 不过滤会变成「任意 SSRF + 内网正文回显」（渗透测试 A-6）。
 */
export async function resolvePublicTarget(hostname: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const net = require('node:net') as typeof import('node:net');
  // IP 字面量直接判，不做 DNS 解析（否则会被 DoH/解析器打回，监控里填 IP 也会失效）
  if (net.isIP(hostname)) {
    return isPrivateAddress(hostname)
      ? { ok: false, reason: '目标不允许指向内网/保留地址' }
      : { ok: true };
  }
  const dns = require('node:dns') as typeof import('node:dns');
  try {
    const addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0) return { ok: false, reason: '目标无法解析' };
    const blocked = addresses.filter((entry) => isPrivateAddress(entry.address));
    if (blocked.length > 0) {
      return { ok: false, reason: '目标解析到内网/保留地址: ' + blocked.map((b) => b.address).join(', ') };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: '目标无法解析: ' + (error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * 校验监控目标：仅允许 IP（含 IPv6）或合法域名。
 * 目标值会进入 ping 进程参数与 HTTP URL，必须先做白名单校验。
 */
function isSafeMonitorHost(value: string): boolean {
  if (!value || value.length > 253) return false;
  const net = require('net');
  if (net.isIP(value)) return true;
  // 合法域名：标签由字母数字与连字符组成，且不以连字符开头/结尾
  return /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(value);
}

/**
 * 以 spawn 参数数组方式调用 ping，不经过 shell，杜绝命令注入。
 */
function pingHost(host: string): Promise<boolean> {
  const { spawn } = require('child_process');
  const args = process.platform === 'win32'
    ? ['-n', '1', '-w', '3000', host]
    : ['-c', '1', '-W', '3', host];
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn('ping', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* 进程可能已退出 */ }
      done(false);
    }, 8000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on('error', () => done(false));
    child.on('close', () => done(/ttl=|time[=<]/i.test(stdout)));
  });
}

async function checkIpAvailabilitySimple(ip: string, method: string, port: number, path: string): Promise<boolean> {
  try {
    // 统一校验目标地址，防止命令注入与非法 URL（ip 会进入 ping 参数或 HTTP URL）
    if (!isSafeMonitorHost(ip)) {
      log.warn('Invalid monitor target rejected', { target: ip, method });
      return false;
    }
    if (method === 'ping') {
      return await pingHost(ip);
    } else if (method === 'tcp') {
      const net = require('net');
      return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(5000);
        socket.on('connect', () => { socket.destroy(); resolve(true); });
        socket.on('timeout', () => { socket.destroy(); resolve(false); });
        socket.on('error', () => { resolve(false); });
        socket.connect(port, ip);
      });
    } else {
      const safePath = sanitizeCheckPath(path);
      return new Promise((resolve) => {
        const req = http.request({ host: ip, port, path: safePath, method: 'GET', timeout: 5000 }, (res) => {
          res.resume();
          resolve((res.statusCode ?? 500) < 500);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
      });
    }
  } catch { return false; }
}

export async function performCheck(monitor: ServiceMonitorMonitor): Promise<{
  status: 'ok' | 'warning' | 'error';
  responseTime: number | null;
  error: string | null;
  resultData: Record<string, unknown> | null;
}> {
  switch (monitor.type) {
    case 'ssl_certificate':
      return checkSSL(monitor.target, monitor.config as SSLCertConfig);
    case 'endpoint':
      return checkEndpoint(monitor.target, monitor.config as EndpointConfig);
    case 'dns_failover':
      return checkFailover(monitor);
    default:
      return { status: 'error', responseTime: null, error: `Unknown monitor type: ${monitor.type}`, resultData: null };
  }
}

export async function runCheckAndUpdate(monitor: ServiceMonitorMonitor): Promise<void> {
  const result = await performCheck(monitor);
  const dbType = getDbType();
  const newStatus = result.status;

  const currentStatus = await ServiceMonitorOperations.getStatus(monitor.id) as any;

  if (dbType === 'sqlite') {
    await ServiceMonitorOperations.updateCheckStatusSQLite(monitor.id, newStatus, result.responseTime, result.error);
  } else if (dbType === 'mysql') {
    await ServiceMonitorOperations.updateCheckStatusMySQL(monitor.id, newStatus, result.responseTime, result.error);
  } else {
    await ServiceMonitorOperations.updateCheckStatusPostgreSQL(monitor.id, newStatus, result.responseTime, result.error);
  }

  const consecutiveUpdates: Record<string, unknown> = {};
  if (newStatus === 'ok') {
    consecutiveUpdates.consecutive_successes = (currentStatus?.consecutive_successes || 0) + 1;
    consecutiveUpdates.consecutive_failures = 0;
  } else {
    consecutiveUpdates.consecutive_failures = (currentStatus?.consecutive_failures || 0) + 1;
    consecutiveUpdates.consecutive_successes = 0;
  }
  await ServiceMonitorOperations.updateStatus(monitor.id, consecutiveUpdates);

  if (result.resultData) {
    await ServiceMonitorOperations.updateStatus(monitor.id, { result_data: JSON.stringify(result.resultData) });
  }

  // Notifications
  if (result.error && monitor.notifyOnFailure) {
    const wasPreviouslyOk = currentStatus?.status === 'ok' || currentStatus?.status === 'warning';
    if (wasPreviouslyOk) {
      try {
        await sendNotification(
          '[服务监控] 告警',
          `监控 "${monitor.name}" (${monitor.target}) 异常: ${result.error}`
        );
      } catch (notifyError) {
        log.error('Failed to send failure notification', { error: notifyError, monitorId: monitor.id });
      }
    }
  } else if (!result.error && monitor.notifyOnRecovery) {
    const wasPreviouslyError = currentStatus?.status === 'error';
    if (wasPreviouslyError) {
      try {
        await sendNotification(
          '[服务监控] 恢复',
          `监控 "${monitor.name}" (${monitor.target}) 已恢复`
        );
      } catch (notifyError) {
        log.error('Failed to send recovery notification', { error: notifyError, monitorId: monitor.id });
      }
    }
  }
}

// ---- Internal mapping ----

function rowToMonitor(row: any): ServiceMonitorMonitor {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    type: row.type,
    target: row.target,
    domainId: row.domain_id || null,
    parentId: row.parent_id || null,
    config: typeof row.config === 'string' ? JSON.parse(row.config) : (row.config || {}),
    checkInterval: row.check_interval,
    checkTimeout: row.check_timeout,
    enabled: row.enabled === 1 || row.enabled === true,
    notifyOnFailure: row.notify_on_failure === 1 || row.notify_on_failure === true,
    notifyOnRecovery: row.notify_on_recovery === 1 || row.notify_on_recovery === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToStatus(row: any): ServiceMonitorStatus {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    status: row.status,
    lastCheckAt: row.last_check_at || null,
    lastSuccessAt: row.last_success_at || null,
    lastFailureAt: row.last_failure_at || null,
    lastError: row.last_error || null,
    lastResponseTime: row.last_response_time || null,
    consecutiveFailures: row.consecutive_failures || 0,
    consecutiveSuccesses: row.consecutive_successes || 0,
    resultData: row.result_data ? (typeof row.result_data === 'string' ? JSON.parse(row.result_data) : row.result_data) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
