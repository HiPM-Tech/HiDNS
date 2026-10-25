import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { McpOperations } from '../db/bal/business-adapter';
import { sendSuccess } from '../utils/http';
import { createLogger } from '../lib/logger';

const log = createLogger('MCP').sub('Route').sub('Oauth');
const router = Router();

const MCP_MODULES = [
  { key: 'ns_monitor', name: 'NS Monitor', nameCn: 'NS 监控' },
  { key: 'domain_management', name: 'Domain Management', nameCn: '域名管理' },
  { key: 'renewal_management', name: 'Renewal Management', nameCn: '续费管理' },
  { key: 'log_query', name: 'Audit Logs', nameCn: '审计日志' },
  { key: 'service_monitor', name: 'ServiceMonitor', nameCn: '服务监控' },
];

const PERMISSION_LABELS: Record<string, { en: string; cn: string }> = {
  disabled: { en: 'Disabled', cn: '禁止' },
  read: { en: 'Read Only', cn: '只读' },
  write: { en: 'Read/Write', cn: '读写' },
};

const PERMISSION_COLORS: Record<string, string> = {
  disabled: '#999',
  read: '#165dff',
  write: '#2ba471',
};

function parseScopeToModules(scopeJson: string | null | undefined): { key: string; level: string }[] {
  if (!scopeJson) return MCP_MODULES.map(m => ({ key: m.key, level: 'disabled' }));
  try {
    const parsed = JSON.parse(scopeJson);
    const scopeStr = typeof parsed === 'string' ? parsed : String(parsed);
    const perms: Record<string, string> = {};
    for (const item of scopeStr.split(',').map(s => s.trim()).filter(Boolean)) {
      const [mod, level] = item.split(':');
      if (mod && level) {
        perms[mod] = level;
      }
    }
    return MCP_MODULES.map(m => ({ key: m.key, level: perms[m.key] || 'disabled' }));
  } catch {
    return MCP_MODULES.map(m => ({ key: m.key, level: 'disabled' }));
  }
}

/** Keep MCP_MODULES, PERMISSION_LABELS, PERMISSION_COLORS, parseScopeToModules for internal use */

/**
 * Generate secure client ID and secret
 */
function generateOAuthCredentials(): { clientId: string; clientSecret: string } {
  const clientId = 'hidns_mcp_' + crypto.randomBytes(16).toString('hex');
  const clientSecret = crypto.randomBytes(32).toString('hex');
  return { clientId, clientSecret };
}

/**
 * @swagger
 * /api/mcp/oauth/clients:
 *   get:
 *     summary: Get current user's OAuth clients
 *     tags: [MCP]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of OAuth clients (without secret)
 */
router.get('/clients', authMiddleware, async (req: Request, res: Response) => {
  try {
    const clients = await McpOperations.getUserOAuthClients(req.user!.userId);
    sendSuccess(res, clients);
  } catch (error) {
    log.error('Failed to get OAuth clients', { error });
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to get OAuth clients' });
  }
});

/**
 * @swagger
 * /api/mcp/oauth/clients:
 *   post:
 *     summary: Create new OAuth client
 *     tags: [MCP]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - app_name
 *               - redirect_uris
 *             properties:
 *               app_name:
 *                 type: string
 *                 description: Application name
 *               redirect_uris:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: List of redirect URIs
 *               scope:
 *                 type: object
 *                 description: Optional permission scopes
 *     responses:
 *       200:
 *         description: OAuth client created (secret shown only once)
 */
router.post('/clients', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { app_name, redirect_uris, scope } = req.body;

    if (!app_name || typeof app_name !== 'string') {
      return res.status(400).json({ code: 400, msg: 'app_name is required' });
    }

    if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      return res.status(400).json({ code: 400, msg: 'redirect_uris is required and must be a non-empty array' });
    }

    const { clientId, clientSecret } = generateOAuthCredentials();

    await McpOperations.createOAuthClient({
      client_id: clientId,
      client_secret: clientSecret,
      user_id: req.user!.userId,
      app_name,
      redirect_uris: JSON.stringify(redirect_uris),
      scope: scope ? JSON.stringify(scope) : undefined,
    });

    log.info(`OAuth client created for user ${req.user!.userId}`, { app_name });

    // Return credentials (only shown once)
    sendSuccess(res, {
      client_id: clientId,
      client_secret: clientSecret,
      message: 'OAuth client created successfully. Please save the client_secret securely, it will not be shown again.',
    });
  } catch (error) {
    log.error('Failed to create OAuth client', { error });
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to create OAuth client' });
  }
});

/**
 * @swagger
 * /api/mcp/oauth/clients/{id}/scope:
 *   put:
 *     summary: Update OAuth client scope
 *     tags: [MCP]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - scope
 *             properties:
 *               scope:
 *                 type: string
 *     responses:
 *       200:
 *         description: Scope updated
 */
router.put('/clients/:id/scope', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { scope } = req.body;
    if (typeof scope !== 'string') {
      return res.status(400).json({ code: 400, msg: 'scope is required' });
    }

    await McpOperations.updateOAuthClientScope(req.params.id, req.user!.userId, scope);
    log.info(`OAuth client scope updated by user ${req.user!.userId}`, { clientId: req.params.id, scope });
    sendSuccess(res, { success: true });
  } catch (error) {
    log.error('Failed to update OAuth client scope', { error });
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to update scope' });
  }
});

/**
 * @swagger
 * /api/mcp/oauth/clients/{id}/expiry:
 *   put:
 *     summary: Update OAuth client expiry date
 *     tags: [MCP]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               expires_at:
 *                 type: string
 *                 format: date
 *                 description: ISO datetime or null to clear
 *     responses:
 *       200:
 *         description: Expiry updated
 */
router.put('/clients/:id/expiry', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { expires_at } = req.body;
    const expiryValue = expires_at ? expires_at : null;

    await McpOperations.updateOAuthClientExpiry(req.params.id, req.user!.userId, expiryValue);
    log.info(`OAuth client expiry updated by user ${req.user!.userId}`, { clientId: req.params.id, expires_at: expiryValue });
    sendSuccess(res, { success: true });
  } catch (error) {
    log.error('Failed to update OAuth client expiry', { error });
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to update expiry' });
  }
});

/**
 * @swagger
 * /api/mcp/oauth/clients/{id}:
 *   delete:
 *     summary: Delete OAuth client
 *     tags: [MCP]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Client ID
 *     responses:
 *       200:
 *         description: OAuth client deleted
 *       404:
 *         description: OAuth client not found
 */
router.delete('/clients/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const clientId = req.params.id;

    await McpOperations.deleteOAuthClient(clientId, req.user!.userId);

    log.info(`OAuth client deleted by user ${req.user!.userId}`, { clientId });

    sendSuccess(res, { success: true, message: 'OAuth client deleted' });
  } catch (error) {
    log.error('Failed to delete OAuth client', { error });
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to delete OAuth client' });
  }
});

/**
 * @swagger
 * /api/mcp/oauth/authorize:
 *   get:
 *     summary: OAuth 2.0 Authorization endpoint — issue authorization code
 *     tags: [MCP]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: response_type
 *         required: true
 *         schema:
 *           type: string
 *           enum: [code]
 *       - in: query
 *         name: client_id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: redirect_uri
 *         required: true
 *         schema:
 *           type: string
 *           format: uri
 *       - in: query
 *         name: scope
 *         schema:
 *           type: string
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *     responses:
 *       302:
 *         description: Redirect to redirect_uri with code and state
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Unauthorized
 */
router.get('/authorize', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { response_type, client_id, redirect_uri, scope, state } = req.query as Record<string, string | undefined>;

    // Validate response_type
    if (response_type !== 'code') {
      const errUrl = redirect_uri
        ? `${redirect_uri}?error=unsupported_response_type&error_description=${encodeURIComponent('Only authorization code flow (response_type=code) is supported')}${state ? `&state=${encodeURIComponent(state)}` : ''}`
        : undefined;
      if (errUrl) return res.redirect(errUrl);
      return res.status(400).json({ error: 'unsupported_response_type', error_description: 'Only response_type=code is supported' });
    }

    if (!client_id || !redirect_uri) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'client_id and redirect_uri are required' });
    }

    // Look up the client
    const client = await McpOperations.getOAuthClient(client_id);
    if (!client) {
      const errUrl = `${redirect_uri}?error=invalid_client&error_description=${encodeURIComponent('Unknown client_id')}${state ? `&state=${encodeURIComponent(state)}` : ''}`;
      return res.redirect(errUrl);
    }

    // Validate redirect_uri against registered URIs
    let registeredUris: string[];
    try { registeredUris = JSON.parse(client.redirect_uris); }
    catch { registeredUris = [client.redirect_uris]; }

    if (!registeredUris.includes(redirect_uri)) {
      const errUrl = `${redirect_uri}?error=invalid_redirect_uri&error_description=${encodeURIComponent('redirect_uri does not match registered URIs')}${state ? `&state=${encodeURIComponent(state)}` : ''}`;
      return res.redirect(errUrl);
    }

    // Check client expiry
    if (client.expires_at && new Date(client.expires_at) < new Date()) {
      const errUrl = `${redirect_uri}?error=access_denied&error_description=${encodeURIComponent('Client registration has expired')}${state ? `&state=${encodeURIComponent(state)}` : ''}`;
      return res.redirect(errUrl);
    }

    // Parse client scope
    let clientScope: string | null = null;
    if (client.scope) {
      try { clientScope = JSON.parse(client.scope); } catch { clientScope = client.scope; }
    }

    // Detect language
    const acceptLang = req.headers['accept-language'] || 'en';
    const lang = acceptLang.split(',')[0] || 'en';

    // Build redirect URL to frontend OAuth consent page
    const frontendParams = new URLSearchParams({
      type: 'mcp',
      client_id,
      redirect_uri,
      app_name: client.app_name || client_id,
      lang,
    });
    if (scope || clientScope) frontendParams.set('scope', scope || clientScope!);
    if (state) frontendParams.set('state', state);

    const frontendUrl = `/oauth/authorize?${frontendParams.toString()}`;
    log.info('Redirecting to frontend consent page', { client_id, frontendUrl });
    res.redirect(frontendUrl);
  } catch (error) {
    log.error('Authorization failed', { error });
    res.status(500).json({ error: 'server_error', error_description: 'Internal server error' });
  }
});

/**
 * POST /api/mcp/oauth/authorize — Consent Decision
 */
router.post('/authorize', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { client_id, redirect_uri, scope, state, decision } = req.body;

    if (!client_id || !redirect_uri || !decision) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'client_id, redirect_uri, and decision are required' });
    }

    if (decision === 'deny') {
      const redirectUrl = `${redirect_uri}?error=access_denied&error_description=${encodeURIComponent('User denied the authorization request')}${state ? `&state=${encodeURIComponent(state)}` : ''}`;
      return res.json({ redirect_url: redirectUrl });
    }

    // Re-validate client
    const client = await McpOperations.getOAuthClient(client_id);
    if (!client) {
      const redirectUrl = `${redirect_uri}?error=invalid_client&error_description=${encodeURIComponent('Unknown client_id')}${state ? `&state=${encodeURIComponent(state)}` : ''}`;
      return res.json({ redirect_url: redirectUrl });
    }

    // Check client expiry
    if (client.expires_at && new Date(client.expires_at) < new Date()) {
      const redirectUrl = `${redirect_uri}?error=access_denied&error_description=${encodeURIComponent('Client registration has expired')}${state ? `&state=${encodeURIComponent(state)}` : ''}`;
      return res.json({ redirect_url: redirectUrl });
    }

    // Generate authorization code (valid for 10 minutes)
    const code = 'hda_' + crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await McpOperations.createAuthCode({
      code,
      client_id,
      user_id: req.user!.userId,
      redirect_uri,
      scope: scope || null,
      expires_at: expiresAt,
    });

    log.info('Authorization code issued after consent', {
      client_id,
      user_id: req.user!.userId,
      redirect_uri,
    });

    // Redirect back to client with the code
    const redirectUrl = `${redirect_uri}?code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ''}`;
    res.json({ redirect_url: redirectUrl });
  } catch (error) {
    log.error('Authorization (POST) failed', { error });
    res.status(500).json({ error: 'server_error', error_description: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/mcp/oauth/register:
 *   post:
 *     summary: Dynamic Client Registration (RFC 7591)
 *     tags: [MCP]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - client_name
 *               - redirect_uris
 *             properties:
 *               client_name:
 *                 type: string
 *                 description: Human-readable client name
 *               redirect_uris:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: List of redirect URIs
 *               scope:
 *                 type: string
 *                 description: Requested permission scopes (comma-separated)
 *               token_endpoint_auth_method:
 *                 type: string
 *                 enum: [client_secret_basic, client_secret_post, none]
 *                 default: client_secret_post
 *     responses:
 *       201:
 *         description: Client registered successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 client_id:
 *                   type: string
 *                 client_secret:
 *                   type: string
 *                 client_id_issued_at:
 *                   type: number
 *                 client_secret_expires_at:
 *                   type: number
 *                 client_name:
 *                   type: string
 *                 redirect_uris:
 *                   type: array
 *                   items:
 *                     type: string
 *                 token_endpoint_auth_method:
 *                   type: string
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    // 动态注册（RFC 7591）默认关闭：开放注册 + 任意 redirect_uri 等于让任何人
    // 拿 HiDNS 当授权服务器用（钓鱼/开放重定向）。
    // 需要时用 MCP_OAUTH_ALLOW_REGISTRATION=true 打开，且回地址只允许回环。
    if (String(process.env.MCP_OAUTH_ALLOW_REGISTRATION ?? '') !== 'true') {
      return res.status(403).json({
        error: 'registration_not_supported',
        error_description: 'Dynamic client registration is disabled. Ask an administrator to create a client.',
      });
    }
    const { client_name, redirect_uris, scope, token_endpoint_auth_method } = req.body;

    if (!client_name || typeof client_name !== 'string') {
      return res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: 'client_name is required',
      });
    }

    if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      return res.status(400).json({
        error: 'invalid_client_metadata',
        error_description: 'redirect_uris is required and must be a non-empty array',
      });
    }
    // 只允许回环地址：避免把 HiDNS 变成开放重定向跳板
    const invalidUri = redirect_uris.find((uri: unknown) => {
      try {
        const parsed = new URL(String(uri));
        return !['http:', 'https:'].includes(parsed.protocol)
          || !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
      } catch {
        return true;
      }
    });
    if (invalidUri) {
      return res.status(400).json({
        error: 'invalid_redirect_uri',
        error_description: 'Only loopback redirect URIs (localhost/127.0.0.1/::1) are allowed',
      });
    }

    const { clientId, clientSecret } = generateOAuthCredentials();

    // Registration — client expires in 6 months by default
    const expiresAt = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();
    await McpOperations.createOAuthClient({
      client_id: clientId,
      client_secret: clientSecret,
      user_id: undefined, // unassigned until authorized via OAuth flow
      app_name: client_name,
      redirect_uris: JSON.stringify(redirect_uris),
      scope: scope ? JSON.stringify(scope) : undefined,
      expires_at: expiresAt,
    });

    const now = Math.floor(Date.now() / 1000);

    log.info('Dynamic client registered (expires in 10m)', {
      client_id: clientId,
      client_name,
    });

    res.status(201).json({
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: now,
      client_secret_expires_at: now + 180 * 24 * 3600, // 6 months
      client_name,
      redirect_uris,
      token_endpoint_auth_method: token_endpoint_auth_method || 'client_secret_post',
    });
  } catch (error) {
    log.error('Dynamic client registration failed', { error });
    res.status(500).json({
      error: 'server_error',
      error_description: 'Internal server error',
    });
  }
});

/**
 * @swagger
 * /api/mcp/oauth/token:
 *   post:
 *     summary: OAuth 2.0 Token endpoint — issue or refresh access token
 *     tags: [MCP]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - grant_type
 *             properties:
 *               grant_type:
 *                 type: string
 *                 enum: [client_credentials, authorization_code, refresh_token]
 *               client_id:
 *                 type: string
 *               client_secret:
 *                 type: string
 *               code:
 *                 type: string
 *                 description: Authorization code (for authorization_code grant)
 *               redirect_uri:
 *                 type: string
 *                 format: uri
 *                 description: Must match the URI used in authorize (for authorization_code grant)
 *               refresh_token:
 *                 type: string
 *                 description: Refresh token (for refresh_token grant)
 *               scope:
 *                 type: string
 *                 description: Requested scope
 *     responses:
 *       200:
 *         description: Token issued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 access_token:
 *                   type: string
 *                 token_type:
 *                   type: string
 *                   example: Bearer
 *                 expires_in:
 *                   type: number
 *                 refresh_token:
 *                   type: string
 *                 scope:
 *                   type: string
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Invalid client credentials
 */
router.post('/token', async (req: Request, res: Response) => {
  try {
    const { grant_type } = req.body;

    switch (grant_type) {
      case 'client_credentials':
        return await handleClientCredentials(req, res);
      case 'authorization_code':
        return await handleAuthorizationCode(req, res);
      case 'refresh_token':
        return await handleRefreshToken(req, res);
      default:
        return res.status(400).json({
          error: 'unsupported_grant_type',
          error_description: 'Supported grant types: client_credentials, authorization_code, refresh_token',
        });
    }
  } catch (error) {
    log.error('Token endpoint error', { error });
    res.status(500).json({ error: 'server_error', error_description: 'Internal server error' });
  }
});

/** ── client_credentials grant ─────────────────────────────────── */
async function handleClientCredentials(req: Request, res: Response) {
  const { client_id, client_secret, scope } = req.body;

  if (!client_id || !client_secret) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'client_id and client_secret are required' });
  }

  const client = await McpOperations.validateClientCredentials(client_id, client_secret);
  if (!client) {
    return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
  }

  const accessToken = 'hdt_' + crypto.randomBytes(32).toString('hex');
  const refreshToken = 'hdr_' + crypto.randomBytes(32).toString('hex');
  const expiresIn = 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  // Parse scope from client - stored as JSON string in MySQL
  let tokenScope: string | undefined;
  if (scope) tokenScope = scope;
  else if (client.scope) {
    try { tokenScope = JSON.parse(client.scope); } catch { tokenScope = client.scope; }
  }

  await McpOperations.createAccessToken({
    access_token: accessToken,
    refresh_token: refreshToken,
    client_id,
    user_id: client.user_id ?? 0,
    scope: tokenScope ? JSON.stringify(tokenScope) : undefined,
    expires_at: expiresAt,
  });

  log.info('Token issued (client_credentials)', { client_id, user_id: client.user_id ?? 0 });

  res.status(200).json({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    scope: tokenScope || '',
  });
}

/** ── authorization_code grant ─────────────────────────────────── */
async function handleAuthorizationCode(req: Request, res: Response) {
  const { client_id, client_secret, code, redirect_uri } = req.body;

  if (!code) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'code is required' });
  }

  // Validate the authorization code
  const authData = await McpOperations.consumeAuthCode(code);
  if (!authData) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid, expired, or already used authorization code' });
  }

  // Validate client credentials
  if (client_id && client_secret) {
    const client = await McpOperations.validateClientCredentials(client_id, client_secret);
    if (!client) {
      return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
    }
    if (client.user_id && authData.user_id && client.user_id !== authData.user_id) {
      return res.status(401).json({ error: 'invalid_client', error_description: 'Client mismatch' });
    }
  }

  // Validate redirect_uri
  if (redirect_uri && redirect_uri !== authData.redirect_uri) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
  }

  // Verify the requesting client matches the code's client
  if (client_id && client_id !== authData.client_id) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id does not match the authorization code' });
  }

  const accessToken = 'hdt_' + crypto.randomBytes(32).toString('hex');
  const refreshToken = 'hdr_' + crypto.randomBytes(32).toString('hex');
  const expiresIn = 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  const operations: Promise<void>[] = [
    McpOperations.createAccessToken({
      access_token: accessToken,
      refresh_token: refreshToken,
      client_id: authData.client_id,
      user_id: authData.user_id,
      scope: authData.scope || undefined,
      expires_at: expiresAt,
    }),
    McpOperations.createRefreshToken({
      refresh_token: refreshToken,
      client_id: authData.client_id,
      user_id: authData.user_id,
      scope: authData.scope || null,
      expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(), // 30 days
    }),
  ];

  await Promise.all(operations);

  log.info('Token issued (authorization_code)', {
    client_id: authData.client_id,
    user_id: authData.user_id,
  });

  res.status(200).json({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    scope: authData.scope || '',
  });
}

/** ── refresh_token grant ──────────────────────────────────────── */
async function handleRefreshToken(req: Request, res: Response) {
  const { refresh_token, client_id, client_secret, scope } = req.body;

  if (!refresh_token) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token is required' });
  }

  // Optionally validate client credentials
  if (client_id && client_secret) {
    const client = await McpOperations.validateClientCredentials(client_id, client_secret);
    if (!client) {
      return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
    }
  }

  // Validate the refresh token
  const tokenData = await McpOperations.validateRefreshToken(refresh_token);
  if (!tokenData) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid, expired, or revoked refresh token' });
  }

  // Verify client_id matches if provided
  if (client_id && client_id !== tokenData.client_id) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
  }

  // Revoke the old refresh token and its associated access tokens
  await McpOperations.revokeRefreshToken(refresh_token);

  // Issue a new access token + refresh token
  const newAccessToken = 'hdt_' + crypto.randomBytes(32).toString('hex');
  const newRefreshToken = 'hdr_' + crypto.randomBytes(32).toString('hex');
  const expiresIn = 3600;

  const effectiveScope = scope || tokenData.scope || '';

  await McpOperations.createAccessToken({
    access_token: newAccessToken,
    refresh_token: newRefreshToken,
    client_id: tokenData.client_id,
    user_id: tokenData.user_id,
    scope: effectiveScope ? JSON.stringify(effectiveScope) : undefined,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
  });

  await McpOperations.createRefreshToken({
    refresh_token: newRefreshToken,
    client_id: tokenData.client_id,
    user_id: tokenData.user_id,
    scope: effectiveScope || null,
    expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(), // 30 days
  });

  log.info('Token refreshed', {
    client_id: tokenData.client_id,
    user_id: tokenData.user_id,
  });

  res.status(200).json({
    access_token: newAccessToken,
    refresh_token: newRefreshToken,
    token_type: 'Bearer',
    expires_in: expiresIn,
    scope: effectiveScope,
  });
}

/**
 * @swagger
 * /api/mcp/oauth/tokens:
 *   get:
 *     summary: List OAuth access tokens
 *     tags: [MCP]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of issued tokens
 */
router.get('/tokens', authMiddleware, async (req: Request, res: Response) => {
  try {
    const tokens = await McpOperations.getOAuthAccessTokens(req.user!.userId);
    sendSuccess(res, tokens);
  } catch (error) {
    log.error('Failed to get tokens', { error });
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to get tokens' });
  }
});

/**
 * @swagger
 * /api/mcp/oauth/tokens/{id}/revoke:
 *   post:
 *     summary: Revoke an access token
 *     tags: [MCP]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: number
 *     responses:
 *       200:
 *         description: Token revoked
 */
router.post('/tokens/:id/revoke', authMiddleware, async (req: Request, res: Response) => {
  try {
    const tokenId = parseInt(req.params.id);
    if (isNaN(tokenId)) {
      return res.status(400).json({ code: 400, msg: 'Invalid token ID' });
    }

    await McpOperations.revokeOAuthTokenById(tokenId, req.user!.userId);

    log.info(`Token revoked by user ${req.user!.userId}`, { tokenId });

    sendSuccess(res, { success: true, message: 'Token revoked' });
  } catch (error) {
    log.error('Failed to revoke token', { error });
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to revoke token' });
  }
});

/**
 * @swagger
 * /api/mcp/oauth/introspect:
 *   post:
 *     summary: Token Introspection (RFC 7662)
 *     tags: [MCP]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               token:
 *                 type: string
 *               token_type_hint:
 *                 type: string
 *                 enum: [access_token, refresh_token]
 *     responses:
 *       200:
 *         description: Token introspection result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 active:
 *                   type: boolean
 *                 scope:
 *                   type: string
 *                 client_id:
 *                   type: string
 *                 user_id:
 *                   type: number
 *                 token_type:
 *                   type: string
 *                 exp:
 *                   type: number
 *                 iat:
 *                   type: number
 */
router.post('/introspect', async (req: Request, res: Response) => {
  try {
    const { token, token_type_hint } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'token is required' });
    }

    const hint = token_type_hint || 'access_token';

    if (hint === 'refresh_token') {
      const rt = await McpOperations.getRefreshTokenByValue(token);
      if (!rt || rt.revoked_at || new Date(rt.expires_at) < new Date()) {
        return res.status(200).json({ active: false });
      }

      // Find associated access token for additional info
      const at = await McpOperations.getAccessTokenByRefreshToken(token);

      return res.status(200).json({
        active: true,
        scope: rt.scope || '',
        client_id: rt.client_id,
        user_id: rt.user_id,
        token_type: 'refresh_token',
        exp: Math.floor(new Date(rt.expires_at).getTime() / 1000),
      });
    }

    // access_token introspection
    const at = await McpOperations.getAccessTokenByValue(token);
    if (!at || at.revoked_at || new Date(at.expires_at) < new Date()) {
      return res.status(200).json({ active: false });
    }

    const response: Record<string, unknown> = {
      active: true,
      scope: at.scope || '',
      client_id: at.client_id,
      user_id: at.user_id,
      token_type: 'Bearer',
      exp: Math.floor(new Date(at.expires_at).getTime() / 1000),
      iat: Math.floor(new Date(at.created_at).getTime() / 1000),
    };

    res.status(200).json(response);
  } catch (error) {
    log.error('Token introspection failed', { error });
    res.status(500).json({ error: 'server_error', error_description: 'Internal server error' });
  }
});

/**
 * @swagger
 * /api/mcp/oauth/revoke:
 *   post:
 *     summary: Token Revocation (RFC 7009)
 *     tags: [MCP]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               token:
 *                 type: string
 *               token_type_hint:
 *                 type: string
 *                 enum: [access_token, refresh_token]
 *     responses:
 *       200:
 *         description: Token revoked (or already invalid)
 */
router.post('/revoke', async (req: Request, res: Response) => {
  try {
    const { token, token_type_hint } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'token is required' });
    }

    const hint = token_type_hint || 'access_token';

    if (hint === 'refresh_token') {
      await McpOperations.revokeRefreshTokenByValue(token);
    } else {
      await McpOperations.revokeAccessTokenByValue(token);
    }

    // Per RFC 7009: always return 200, even if the token was already invalid
    res.status(200).json({});
  } catch (error) {
    log.error('Token revocation failed', { error });
    res.status(500).json({ error: 'server_error', error_description: 'Internal server error' });
  }
});

export default router;
