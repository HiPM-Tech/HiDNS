import { Router, Request, Response } from 'express';
import { authMiddleware, adminOnly, noTokenAuth } from '../middleware/auth';
import bcrypt from 'bcryptjs';
import { getLoginLimitConfig, updateLoginLimitConfig, getLoginAttemptStats, unlockAccount } from '../service/loginLimit';
import { SettingsOperations, NotificationOperations, AuditRuleOperations, DomainExpiryOperations, UserOperations } from '../db/bal/business-adapter';
import { getSmtpConfig, updateSmtpConfig, sendSmtpEmail } from '../service/smtp';
import { logAuditOperation } from '../service/audit';
import { reloadOutboundPolicy } from '../workflow/index';
import { createLogger } from '../lib/logger';
import { wsService } from '../service/websocket';
import { sendError } from '../utils/http';

const log = createLogger('HTTP').sub('Route').sub('Settings');
const router = Router();
type SecurityConfig = { jwtViewEmailNotify: boolean; showDnsProviderSecrets: boolean };
const DEFAULT_SECURITY_CONFIG: SecurityConfig = { jwtViewEmailNotify: true, showDnsProviderSecrets: false };
type OAuthConfig = {
  enabled: boolean;
  template: 'generic' | 'logto';
  providerName: string;
  subjectKey: string;
  emailKey: string;
  logtoDomain: string;
  clientId: string;
  clientSecret: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userInfoEndpoint: string;
  jwksUri: string;
  scopes: string;
  redirectUri: string;
};
const DEFAULT_OAUTH_CONFIG: OAuthConfig = {
  enabled: false,
  template: 'generic',
  providerName: 'default',
  subjectKey: 'sub',
  emailKey: 'email',
  logtoDomain: '',
  clientId: '',
  clientSecret: '',
  issuer: '',
  authorizationEndpoint: '',
  tokenEndpoint: '',
  userInfoEndpoint: '',
  jwksUri: '',
  scopes: 'openid profile email',
  redirectUri: '',
};
const DEFAULT_LOGTO_OAUTH_CONFIG: OAuthConfig = {
  ...DEFAULT_OAUTH_CONFIG,
  template: 'logto',
  providerName: 'Logto',
};

function normalizeLogtoDomain(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Invalid Logto domain URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error('Logto domain must use https');
  }
  return `${url.protocol}//${url.host}`;
}

function applyOAuthTemplate(input: OAuthConfig): OAuthConfig {
  if (input.template !== 'logto') return input;
  const domain = normalizeLogtoDomain(input.logtoDomain);
  if (!domain) throw new Error('logtoDomain is required for Logto template');
  return {
    ...input,
    logtoDomain: domain,
    providerName: input.providerName || 'Logto',
    issuer: `${domain}/oidc`,
    jwksUri: `${domain}/oidc/jwks`,
    authorizationEndpoint: `${domain}/oidc/auth`,
    tokenEndpoint: `${domain}/oidc/token`,
    userInfoEndpoint: `${domain}/oidc/me`,
  };
}

async function getSecurityConfig(): Promise<SecurityConfig> {
  const value = await SettingsOperations.get('security_config');
  if (!value) return DEFAULT_SECURITY_CONFIG;
  try {
    const parsed = JSON.parse(value) as Partial<SecurityConfig>;
    return { ...DEFAULT_SECURITY_CONFIG, ...parsed };
  } catch {
    return DEFAULT_SECURITY_CONFIG;
  }
}

async function updateSecurityConfig(input: Partial<SecurityConfig>): Promise<SecurityConfig> {
  const next = { ...(await getSecurityConfig()), ...input };
  await SettingsOperations.set('security_config', JSON.stringify(next));
  return next;
}

async function getOAuthConfig(): Promise<OAuthConfig> {
  const value = await SettingsOperations.get('oauth_config');
  if (!value) return DEFAULT_OAUTH_CONFIG;
  try {
    const parsed = JSON.parse(value) as Partial<OAuthConfig>;
    return { ...DEFAULT_OAUTH_CONFIG, ...parsed };
  } catch {
    return DEFAULT_OAUTH_CONFIG;
  }
}

async function getLogtoOAuthConfig(): Promise<OAuthConfig> {
  const value = await SettingsOperations.get('oauth_logto_config');
  if (!value) return DEFAULT_LOGTO_OAUTH_CONFIG;
  try {
    const parsed = JSON.parse(value) as Partial<OAuthConfig>;
    return { ...DEFAULT_LOGTO_OAUTH_CONFIG, ...parsed, template: 'logto' };
  } catch {
    return DEFAULT_LOGTO_OAUTH_CONFIG;
  }
}

async function updateOAuthConfig(input: Partial<OAuthConfig>): Promise<OAuthConfig> {
  const next = applyOAuthTemplate({ ...(await getOAuthConfig()), ...input });
  if (next.enabled) {
    const required = ['clientId', 'clientSecret', 'authorizationEndpoint', 'tokenEndpoint', 'userInfoEndpoint', 'jwksUri'] as const;
    for (const k of required) {
      if (!String(next[k] || '').trim()) throw new Error(`${k} is required`);
    }
    if (!String(next.subjectKey || '').trim()) throw new Error('subjectKey is required');
  }
  await SettingsOperations.set('oauth_config', JSON.stringify(next));
  return next;
}

async function updateLogtoOAuthConfig(input: Partial<OAuthConfig>): Promise<OAuthConfig> {
  const next = applyOAuthTemplate({ ...(await getLogtoOAuthConfig()), ...input, template: 'logto' });
  if (next.enabled) {
    const required = ['clientId', 'clientSecret', 'authorizationEndpoint', 'tokenEndpoint', 'userInfoEndpoint', 'jwksUri'] as const;
    for (const k of required) {
      if (!String(next[k] || '').trim()) throw new Error(`${k} is required`);
    }
  }
  await SettingsOperations.set('oauth_logto_config', JSON.stringify(next));
  return next;
}

/**
 * @swagger
 * /api/settings/jwt-secret:
 *   post:
 *     summary: Verify initial super admin password and get JWT base secret (admin only)
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [password]
 *             properties:
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: JWT base secret
 */
router.post('/jwt-secret', authMiddleware, noTokenAuth('system settings'), adminOnly, async (req: Request, res: Response) => {
  const { password } = req.body as { password?: string };
  if (!password) {
    res.status(400).json({ code: 400, msg: 'Password is required' });
    return;
  }

  const currentUser = await UserOperations.getById(req.user!.userId);
  if (!currentUser || !bcrypt.compareSync(password, currentUser.password_hash as string)) {
    res.status(401).json({ code: 401, msg: 'Invalid admin password' });
    return;
  }

  const allUsers = await UserOperations.getAll();
  const initialSuper = allUsers.find(u => u.role_level === 3);
  if (!initialSuper || initialSuper.id !== req.user!.userId) {
    res.status(403).json({ code: 403, msg: 'Only the initial super admin can view JWT secret' });
    return;
  }

  const jwtSecret = process.env.JWT_SECRET || '';
  await logAuditOperation(req.user!.userId, 'view_jwt_secret', 'system', { success: true }, req);
  try {
    const secCfg = await getSecurityConfig();
    if (secCfg.jwtViewEmailNotify) {
      const superInfo = await UserOperations.getById(initialSuper.id);
      if (superInfo?.email) {
        await sendSmtpEmail(
          superInfo.email as string,
          'HiDNS Security Notice: JWT Secret Viewed',
          `Hello ${superInfo.username || 'admin'},\n\nYour JWT secret was viewed at ${new Date().toISOString()} by user ID ${req.user!.userId}.`
        );
      }
    }
  } catch (e) {
    log.warn('Failed to send JWT view notification email', { error: e });
  }
  res.json({
    code: 0,
    data: { jwtSecret },
    msg: 'success',
  });
});

router.get('/notifications', authMiddleware, noTokenAuth('system settings'), adminOnly, async (_req: Request, res: Response) => {
  const value = await NotificationOperations.getChannels();
  if (!value) {
    res.json({ code: 0, data: [], msg: 'success' });
    return;
  }
  try {
    const channels = JSON.parse(value);
    res.json({ code: 0, data: channels, msg: 'success' });
  } catch {
    res.json({ code: 0, data: [], msg: 'success' });
  }
});

router.put('/notifications', authMiddleware, noTokenAuth('system settings'), adminOnly, async (req: Request, res: Response) => {
  const channels = req.body.channels;
  if (!Array.isArray(channels)) return sendError(res, 'Invalid channels array', 400);

  await NotificationOperations.saveChannels(JSON.stringify(channels));
  res.json({ code: 0, msg: 'success' });
});

router.get('/audit-rules', authMiddleware, noTokenAuth('system settings'), adminOnly, async (req: Request, res: Response) => {
  const value = await AuditRuleOperations.getRules();
  const defaultRules = {
    enabled: true,
    maxDeletionsPerHour: 10,
    maxFailedLogins: 5,
    offHoursStart: '22:00',
    offHoursEnd: '06:00'
  };
  if (!value) {
    res.json({ code: 0, data: defaultRules, msg: 'success' });
    return;
  }
  try {
    const rules = JSON.parse(value);
    res.json({ code: 0, data: { ...defaultRules, ...rules }, msg: 'success' });
  } catch {
    res.json({ code: 0, data: defaultRules, msg: 'success' });
  }
});

router.put('/audit-rules', authMiddleware, noTokenAuth('system settings'), adminOnly, async (req: Request, res: Response) => {
  const rules = req.body.rules;
  if (!rules) return sendError(res, 'Rules required', 400);

  await AuditRuleOperations.saveRules(JSON.stringify(rules));
  const defaultRules = {
    enabled: true,
    maxDeletionsPerHour: 10,
    maxFailedLogins: 5,
    offHoursStart: '22:00',
    offHoursEnd: '06:00'
  };
  res.json({ code: 0, data: { ...defaultRules, ...rules }, msg: 'success' });
});

router.get('/security', authMiddleware, noTokenAuth('system settings'), adminOnly, async (_req: Request, res: Response) => {
  const value = await SettingsOperations.get('security_config');

  const expiryNotifyValue = await DomainExpiryOperations.getNotification();
  const expiryDaysValue = await DomainExpiryOperations.getDays();

  const defaultConf = {
    jwtViewEmailNotify: false,
    domainExpiryNotify: expiryNotifyValue ? (expiryNotifyValue === '1' || expiryNotifyValue === 'true') : false,
    domainExpiryDays: expiryDaysValue ? parseInt(expiryDaysValue) : 30
  };

  if (!value) {
    res.json({ code: 0, data: defaultConf, msg: 'success' });
    return;
  }

  try {
    const config = JSON.parse(value);
    res.json({ code: 0, data: { ...defaultConf, ...config }, msg: 'success' });
  } catch {
    res.json({ code: 0, data: defaultConf, msg: 'success' });
  }
});

router.put('/security', authMiddleware, noTokenAuth('system settings'), adminOnly, async (req: Request, res: Response) => {
  const { jwtViewEmailNotify, domainExpiryNotify, domainExpiryDays, showDnsProviderSecrets } = req.body;
  const config = {
    jwtViewEmailNotify: !!jwtViewEmailNotify,
    showDnsProviderSecrets: !!showDnsProviderSecrets
  };

  await SettingsOperations.set('security_config', JSON.stringify(config));
  if (domainExpiryNotify !== undefined) {
    await DomainExpiryOperations.saveNotification(domainExpiryNotify ? '1' : '0');
  }
  if (domainExpiryDays !== undefined) {
    await DomainExpiryOperations.saveDays(String(domainExpiryDays));
  }

  // 推送 WebSocket 消息
  try {
    wsService.broadcast({
      type: 'security_config_updated',
      data: {
        updatedBy: req.user!.userId,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    log.error('Failed to broadcast security_config_updated event', { error });
  }

  res.json({ code: 0, msg: 'success' });
});

router.get('/smtp', authMiddleware, noTokenAuth('system settings'), adminOnly, async (_req: Request, res: Response) => {
  try {
    const config = await getSmtpConfig();
    res.json({ code: 0, data: config, msg: 'success' });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to get SMTP config' });
  }
});

router.put('/smtp', authMiddleware, noTokenAuth('system settings'), adminOnly, async (req: Request, res: Response) => {
  try {
    const next = await updateSmtpConfig(req.body || {});
    await logAuditOperation(req.user!.userId, 'update_smtp_config', 'system', { enabled: next.enabled, host: next.host, port: next.port }, req);

    // 推送 WebSocket 消息
    try {
      wsService.broadcast({
        type: 'smtp_updated',
        data: {
          updatedBy: req.user!.userId,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      log.error('Failed to broadcast smtp_updated event', { error });
    }

    res.json({ code: 0, data: next, msg: 'success' });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to update SMTP config' });
  }
});

router.post('/smtp/test', authMiddleware, adminOnly, async (req: Request, res: Response) => {
  const { to } = req.body as { to?: string };
  try {
    const me = await UserOperations.getById(req.user!.userId);
    const target = (to || (me?.email as string) || '').trim();
    if (!target) {
      res.status(400).json({ code: 400, msg: 'Target email is required' });
      return;
    }
    log.info('Sending test email', { to: target, fromUser: req.user!.userId });
    await sendSmtpEmail(target, 'HiDNS SMTP Test', 'This is a test email from HiDNS SMTP settings.');
    await logAuditOperation(req.user!.userId, 'smtp_test_email', 'system', { to: target }, req);
    log.info('Test email sent successfully', { to: target });
    res.json({ code: 0, msg: 'success' });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    log.error('Failed to send test email', {
      error: errorMsg,
      stack: errorStack,
      to: to || '(not provided)',
      userId: req.user?.userId
    });
    res.status(500).json({ code: 500, msg: `Failed to send test email: ${errorMsg}` });
  }
});

router.get('/oauth', authMiddleware, noTokenAuth('system settings'), adminOnly, async (_req: Request, res: Response) => {
  try {
    const config = await getOAuthConfig();
    res.json({ code: 0, data: config, msg: 'success' });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to get OAuth config' });
  }
});

router.put('/oauth', authMiddleware, noTokenAuth('system settings'), adminOnly, async (req: Request, res: Response) => {
  try {
    const config = await updateOAuthConfig({ ...(req.body || {}), template: 'generic' });
    await logAuditOperation(req.user!.userId, 'update_oauth_config', 'system', { enabled: config.enabled, providerName: config.providerName, issuer: config.issuer }, req);

    // 推送 WebSocket 消息
    try {
      wsService.broadcast({
        type: 'oauth_updated',
        data: {
          updatedBy: req.user!.userId,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      log.error('Failed to broadcast oauth_updated event', { error });
    }

    res.json({ code: 0, data: config, msg: 'success' });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to update OAuth config' });
  }
});

router.get('/oauth/logto', authMiddleware, noTokenAuth('system settings'), adminOnly, async (_req: Request, res: Response) => {
  try {
    const config = await getLogtoOAuthConfig();
    res.json({ code: 0, data: config, msg: 'success' });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to get Logto OAuth config' });
  }
});

router.put('/oauth/logto', authMiddleware, noTokenAuth('system settings'), adminOnly, async (req: Request, res: Response) => {
  try {
    const config = await updateLogtoOAuthConfig(req.body || {});
    await logAuditOperation(req.user!.userId, 'update_logto_oauth_config', 'system', { enabled: config.enabled, providerName: config.providerName, logtoDomain: config.logtoDomain }, req);

    // 推送 WebSocket 消息
    try {
      wsService.broadcast({
        type: 'oauth_updated',
        data: {
          updatedBy: req.user!.userId,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      log.error('Failed to broadcast oauth_updated event', { error });
    }

    res.json({ code: 0, data: config, msg: 'success' });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to update Logto OAuth config' });
  }
});

router.post('/oauth/oidc-discover', authMiddleware, noTokenAuth('system settings'), adminOnly, async (req: Request, res: Response) => {
  const { issuer } = req.body as { issuer?: string };
  if (!issuer) {
    res.status(400).json({ code: 400, msg: 'issuer is required' });
    return;
  }
  try {
    const base = issuer.replace(/\/+$/, '');
    const url = `${base}/.well-known/openid-configuration`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`OIDC discovery failed: HTTP ${response.status}`);
    }
    const data = await response.json() as Record<string, unknown>;
    const mapped: Partial<OAuthConfig> = {
      issuer: String(data.issuer || base),
      authorizationEndpoint: String(data.authorization_endpoint || ''),
      tokenEndpoint: String(data.token_endpoint || ''),
      userInfoEndpoint: String(data.userinfo_endpoint || ''),
      jwksUri: String(data.jwks_uri || ''),
      scopes: Array.isArray(data.scopes_supported) ? (data.scopes_supported as unknown[]).join(' ') : DEFAULT_OAUTH_CONFIG.scopes,
      subjectKey: DEFAULT_OAUTH_CONFIG.subjectKey,
      emailKey: DEFAULT_OAUTH_CONFIG.emailKey,
      template: 'generic',
    };
    res.json({ code: 0, data: mapped, msg: 'success' });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'OIDC discovery failed' });
  }
});

/**
 * @swagger
 * /api/settings/login-limit:
 *   get:
 *     summary: Get login limit configuration
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Login limit configuration
 */
router.get('/login-limit', authMiddleware, noTokenAuth('system settings'), adminOnly, async (req: Request, res: Response) => {
  try {
    const config = await getLoginLimitConfig();
    res.json({
      code: 0,
      data: config,
      msg: 'success',
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      msg: error instanceof Error ? error.message : 'Failed to get login limit config',
    });
  }
});

/**
 * @swagger
 * /api/settings/login-limit:
 *   put:
 *     summary: Update login limit configuration
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enabled:
 *                 type: boolean
 *               maxAttempts:
 *                 type: integer
 *               lockoutDuration:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Configuration updated
 */
router.put('/login-limit', authMiddleware, noTokenAuth('system settings'), adminOnly, async (req: Request, res: Response) => {
  const { enabled, maxAttempts, lockoutDuration } = req.body;

  try {
    const updateData: Partial<{ enabled: boolean; maxAttempts: number; lockoutDuration: number }> = {};

    if (enabled !== undefined) updateData.enabled = enabled;
    if (maxAttempts !== undefined) updateData.maxAttempts = maxAttempts;
    if (lockoutDuration !== undefined) updateData.lockoutDuration = lockoutDuration;

    await updateLoginLimitConfig(updateData);

    const config = await getLoginLimitConfig();

    // 推送 WebSocket 消息
    try {
      wsService.broadcast({
        type: 'config_updated',
        data: {
          configType: 'login_limit',
          updatedBy: req.user!.userId,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      log.error('Failed to broadcast config_updated event', { error });
    }

    res.json({
      code: 0,
      data: config,
      msg: 'success',
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      msg: error instanceof Error ? error.message : 'Failed to update login limit config',
    });
  }
});

/**
 * @swagger
 * /api/settings/login-attempts/stats:
 *   get:
 *     summary: Get login attempt statistics
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Login attempt statistics
 */
router.get('/login-attempts/stats', authMiddleware, noTokenAuth('system settings'), adminOnly, async (req: Request, res: Response) => {
  try {
    const stats = await getLoginAttemptStats();
    res.json({
      code: 0,
      data: stats,
      msg: 'success',
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      msg: error instanceof Error ? error.message : 'Failed to get login attempt stats',
    });
  }
});

/**
 * @swagger
 * /api/settings/login-attempts/unlock:
 *   post:
 *     summary: Manually unlock an account
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [identifier]
 *             properties:
 *               identifier:
 *                 type: string
 *     responses:
 *       200:
 *         description: Account unlocked
 */
router.post('/login-attempts/unlock', authMiddleware, noTokenAuth('system settings'), adminOnly, async (req: Request, res: Response) => {
  const { identifier } = req.body;

  if (!identifier) {
    sendError(res, 'Identifier is required', 400);
    return;
  }

  try {
    await unlockAccount(identifier);
    res.json({
      code: 0,
      msg: 'Account unlocked successfully',
    });
  } catch (error) {
    res.status(500).json({
      code: 500,
      msg: error instanceof Error ? error.message : 'Failed to unlock account',
    });
  }
});

export default router;
/**
 * 工作流出站白名单（设计 §5.5.1）。
 * 此前只有读取方没有写入方，导致 allowlist 恒为空、http.outbound.fetch 永远 NOT_ALLOWLISTED。
 */
router.get('/workflow-http-allowlist', authMiddleware, noTokenAuth('system settings'), adminOnly, async (_req: Request, res: Response) => {
  const raw = await SettingsOperations.get('workflow_http_allowlist');
  let allowlist: string[] = [];
  const text = typeof raw === 'string' ? raw : (raw as unknown as { value?: string } | null)?.value;
  if (text) {
    try {
      const parsed: unknown = JSON.parse(String(text));
      if (Array.isArray(parsed)) allowlist = parsed.map((item) => String(item));
    } catch {
      allowlist = String(text).split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
    }
  }
  res.json({ code: 0, data: { allowlist }, msg: 'success' });
});

router.put('/workflow-http-allowlist', authMiddleware, noTokenAuth('system settings'), adminOnly, async (req: Request, res: Response) => {
  const { allowlist } = req.body as { allowlist?: unknown };
  if (!Array.isArray(allowlist) || allowlist.some((item) => typeof item !== 'string')) {
    sendError(res, 'allowlist 必须是字符串数组', 400);
    return;
  }
  const normalized = allowlist.map((item) => String(item).trim()).filter(Boolean);
  await SettingsOperations.set('workflow_http_allowlist', JSON.stringify(normalized));
  // 立即重载，避免必须重启进程
  await reloadOutboundPolicy();
  await logAuditOperation(
    Number(req.user!.userId),
    'update_workflow_http_allowlist',
    'workflow',
    { count: normalized.length },
    req as never,
  );
  res.json({ code: 0, data: { allowlist: normalized }, msg: 'success' });
});