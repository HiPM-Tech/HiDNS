import { Router, Request, Response } from 'express';
import { resolveWebAuthnConfig } from './webauthn';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { authMiddleware, noTokenAuth } from '../middleware/auth';
import { signToken } from '../service/jwt';
import { User } from '../types';
import { checkLoginAllowed, recordFailedAttempt, clearLoginAttempts } from '../service/loginLimit';
import { sendEmailVerificationCode, verifyEmailVerificationCode } from '../service/emailVerification';
import { logAuditOperation } from '../service/audit';
import { getSmtpConfig, sendSmtpEmail } from '../service/smtp';
import { getUserPreferences, updateUserPreferences, UserPreferences } from '../service/userPreferences';
import { loginLimiter, emailLimiter } from '../middleware/rateLimit';
import { getTOTPStatus, verifyTOTPToken, verifyBackupCode } from '../service/totp';
import { createLogger } from '../lib/logger';
import { UserOperations, OAuthOperations, TwoFAOperations, SettingsOperations, UserPreferencesOperations, DomainOperations } from '../db/bal/business-adapter';
import { requires2FA, has2FAEnabled, validatePassword, getSecurityPolicy, SecurityPolicy } from '../service/securityPolicy';
import { verifyTrustedDevice, addTrustedDevice, DeviceInfo } from '../service/deviceTrust';
import { getRequestIP } from '../middleware/clientIP';
import db from '../db/bal/business-adapter';
import { sendError, sendSuccess } from '../utils/http';

const log = createLogger('HTTP').sub('Route').sub('Auth');
/**
 * RSA Key Pair for password encryption
 * Generated once and cached for the lifetime of the server
 */
interface RSAKeyPair {
  publicKey: string;
  privateKey: string;
}

let rsaKeyPair: RSAKeyPair | null = null;
const KEY_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
let keyGeneratedAt = 0;

function getOrGenerateRSAKeyPair(): RSAKeyPair {
  const now = Date.now();

  // Regenerate keys if expired or not generated
  if (!rsaKeyPair || (now - keyGeneratedAt) > KEY_CACHE_TTL) {
    log.info('Generating new RSA key pair for password encryption');

    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem'
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem'
      }
    });

    rsaKeyPair = { publicKey, privateKey };
    keyGeneratedAt = now;
  }

  return rsaKeyPair;
}

function decryptPassword(encryptedPassword: string): string {
  try {
    const keyPair = getOrGenerateRSAKeyPair();

    // Decode from base64
    const buffer = Buffer.from(encryptedPassword, 'base64');

    // Decrypt using private key
    const decrypted = crypto.privateDecrypt(
      {
        key: keyPair.privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
      },
      buffer
    );

    return decrypted.toString('utf-8');
  } catch (error) {
    log.error('Failed to decrypt password', { error: error instanceof Error ? error.message : String(error) });
    throw new Error('Invalid encrypted password');
  }
}

/**
 * 从请求中解析客户端原始协议（支持多层反向代理）
 *
 * X-Forwarded-Proto 格式：
 *   单层代理: https
 *   多层代理: https, http, http  ← 取第一个值（最外层原始协议）
 *   无代理: 直接从 req.protocol 获取
 */
function getClientProtocol(req: Request): string {
  const forwardedProto = req.headers['x-forwarded-proto'];

  if (Array.isArray(forwardedProto)) {
    return forwardedProto[0].split(',')[0].trim();
  }

  if (forwardedProto) {
    return forwardedProto.split(',')[0].trim();
  }

  return req.protocol || 'http';
}

/**
 * Set secure httpOnly cookie for JWT token
 *
 * secure flag behavior:
 * - COOKIE_SECURE=true  → force HTTPS-only (most secure)
 * - COOKIE_SECURE=false → allow HTTP (least secure, but flexible)
 * - COOKIE_SECURE unset → auto-detect from request protocol:
 *     HTTPS → secure: true, HTTP → secure: false
 *   This ensures both HTTP and HTTPS work in production behind a reverse proxy.
 */
function setAuthCookie(res: Response, token: string): void {
  const cookieSecureEnv = process.env.COOKIE_SECURE;
  let secureFlag: boolean;

  if (cookieSecureEnv !== undefined && cookieSecureEnv !== '') {
    secureFlag = cookieSecureEnv === 'true';
  } else {
    secureFlag = getClientProtocol(res.req!) === 'https';
  }

  res.cookie('token', token, {
    httpOnly: true,
    secure: secureFlag,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}


const router = Router();
// OAuth state 现在存储在数据库中，不再使用内存 Map
// const oauthStateStore = new Map<string, { mode: 'login' | 'bind'; provider: 'custom' | 'logto'; userId?: number; expiresAt: number }>();
const processingCallbacks = new Set<string>();
// 记录已成功处理的code，使用 Map 带时间戳支持自动过期（最多保留1000个，避免内存泄漏）
const processedCodes = new Map<string, number>(); // code -> timestamp
const PROCESSED_CODES_TTL = 5 * 60 * 1000; // 5分钟TTL
const MAX_PROCESSED_CODES = 1000;

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
  providerName: 'OIDC',
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

type OAuthUserProfile = Record<string, unknown>;

type LoginUserInfo = {
  id: number;
  username: string;
  nickname: string;
  email: string;
  role: 1 | 2 | 3;
  status: number;
};

function randomHex(size: number): string {
  return crypto.randomBytes(size).toString('hex');
}

function addProcessedCode(code: string): void {
  const now = Date.now();

  // 先清理过期条目
  for (const [key, timestamp] of processedCodes.entries()) {
    if (now - timestamp > PROCESSED_CODES_TTL) {
      processedCodes.delete(key);
    }
  }

  // 如果仍然超过限制，删除最旧的条目
  if (processedCodes.size >= MAX_PROCESSED_CODES) {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, timestamp] of processedCodes.entries()) {
      if (timestamp < oldestTime) {
        oldestTime = timestamp;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      processedCodes.delete(oldestKey);
    }
  }

  processedCodes.set(code, now);
}

function sanitizeConfigValue(value: string): string {
  // 去除 Markdown 反引号和多余空格
  return value.replace(/^`+|`+$/g, '').trim();
}

async function getOAuthConfigByProvider(provider: 'custom' | 'logto'): Promise<OAuthConfig> {
  const key = provider === 'logto' ? 'oauth_logto_config' : 'oauth_config';
  const defaults: OAuthConfig = provider === 'logto'
    ? { ...DEFAULT_OAUTH_CONFIG, template: 'logto', providerName: 'Logto' }
    : { ...DEFAULT_OAUTH_CONFIG, template: 'generic', providerName: 'Custom' };
  const value = await SettingsOperations.get(key);
  if (!value) return defaults;
  try {
    const parsed = JSON.parse(value) as Partial<OAuthConfig>;
    // 清洗 URL 字段，去除可能的 Markdown 反引号
    const sanitized: Partial<OAuthConfig> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && (k.includes('Endpoint') || k.includes('Uri') || k === 'issuer')) {
        sanitized[k as keyof OAuthConfig] = sanitizeConfigValue(v) as never;
      } else {
        sanitized[k as keyof OAuthConfig] = v as never;
      }
    }
    return { ...defaults, ...sanitized };
  } catch {
    return defaults;
  }
}

/** 选择本次登录使用的提供商：显式指定优先；否则第一个已启用的（只开 Logto 时不会误用 custom） */
export function pickOAuthProvider(
  requested: 'custom' | 'logto' | undefined,
  enabled: Array<{ key: 'custom' | 'logto' }>,
): 'custom' | 'logto' {
  if (requested) {
    if (!enabled.some((item) => item.key === requested)) throw new Error('OAuth provider is not enabled');
    return requested;
  }
  return enabled[0]?.key ?? 'custom';
}

async function getEnabledOAuthProviders(): Promise<Array<{ key: 'custom' | 'logto'; providerName: string }>> {
  const providers: Array<{ key: 'custom' | 'logto'; providerName: string }> = [];
  const custom = await getOAuthConfigByProvider('custom');
  if (custom.enabled) providers.push({ key: 'custom', providerName: custom.providerName || 'OIDC' });
  const logto = await getOAuthConfigByProvider('logto');
  if (logto.enabled) providers.push({ key: 'logto', providerName: logto.providerName || 'Logto' });
  return providers;
}

function getProviderKey(config: OAuthConfig): string {
  return (config.providerName || 'oidc').trim().toLowerCase();
}

function assertOAuthEnabled(config: OAuthConfig): void {
  if (!config.enabled) {
    throw new Error('OAuth login is disabled');
  }
  if (!config.clientId || !config.clientSecret || !config.authorizationEndpoint || !config.tokenEndpoint || !config.userInfoEndpoint) {
    throw new Error('OAuth config is incomplete');
  }
}

async function exchangeOauthCode(config: OAuthConfig, code: string): Promise<{ accessToken: string; idToken?: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
  });
  // 卫生：不打印 body 原文（含 client_secret / code），只打印字段名摘要
  log.debug('Token request', { endpoint: config.tokenEndpoint, bodyKeys: [...new URLSearchParams(body.toString()).keys()] });
  try {
    const response = await fetch(config.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    log.debug('Token response', { status: response.status });
    const tokenPayload = await response.json() as { access_token?: string; id_token?: string; error?: string; error_description?: string };
    // 卫生：token 响应含 access_token / id_token，只记录是否拿到与键名
    log.debug('Token response payload', {
      keys: Object.keys(tokenPayload),
      hasAccessToken: Boolean(tokenPayload.access_token),
      hasIdToken: Boolean(tokenPayload.id_token),
      error: tokenPayload.error,
    });
    if (!response.ok) {
      throw new Error(`OAuth token exchange failed: HTTP ${response.status}${tokenPayload.error_description ? ' - ' + tokenPayload.error_description : ''}`);
    }
    if (!tokenPayload.access_token) {
      throw new Error('OAuth token exchange failed: access_token missing');
    }
    return { accessToken: tokenPayload.access_token, idToken: tokenPayload.id_token || '' };
  } catch (error) {
    log.error('Token request failed', { error: error instanceof Error ? error.message : String(error), endpoint: config.tokenEndpoint });
    throw error;
  }
}

async function fetchOAuthProfile(config: OAuthConfig, accessToken: string): Promise<OAuthUserProfile> {
  const response = await fetch(config.userInfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`OAuth userinfo failed: HTTP ${response.status}`);
  }
  const profile = await response.json() as OAuthUserProfile;
  return profile;
}

function getOAuthField(profile: OAuthUserProfile, field: string): string {
  const v = profile[field];
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  return '';
}

function resolveOAuthSubject(config: OAuthConfig, profile: OAuthUserProfile): string {
  const candidates = [config.subjectKey, 'sub', 'id', 'user_id', 'uid']
    .map((s) => (s || '').trim())
    .filter(Boolean);
  for (const key of candidates) {
    const value = getOAuthField(profile, key);
    if (value) return value;
  }
  throw new Error(`OAuth userinfo missing subject key. Tried: ${candidates.join(', ')}`);
}

function resolveOAuthEmail(config: OAuthConfig, profile: OAuthUserProfile): string {
  const candidates = [config.emailKey, 'email', 'mail']
    .map((s) => (s || '').trim())
    .filter(Boolean);
  for (const key of candidates) {
    const value = getOAuthField(profile, key);
    if (value) return value.toLowerCase();
  }
  return '';
}

function buildOauthAuthUrl(config: OAuthConfig, state: string): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes || 'openid profile email',
    state,
  });
  return `${config.authorizationEndpoint}?${query.toString()}`;
}

function decodeBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 ? '='.repeat(4 - (normalized.length % 4)) : '';
  return Buffer.from(normalized + pad, 'base64');
}

function ellipticSigToDer(r: Buffer, s: Buffer): Buffer {
  const rLen = r.length;
  const sLen = s.length;
  const totalLen = rLen + sLen + 10;
  const der = Buffer.alloc(totalLen);
  let offset = 0;
  der[offset++] = 0x30;
  der[offset++] = totalLen - 2;
  der[offset++] = 0x02;
  der[offset++] = rLen;
  r.copy(der, offset);
  offset += rLen;
  der[offset++] = 0x02;
  der[offset++] = sLen;
  s.copy(der, offset);
  return der.slice(0, offset + sLen);
}

async function verifyIdToken(idToken: string, config: OAuthConfig): Promise<OAuthUserProfile> {
  if (!idToken || !config.jwksUri) return {};
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Invalid id_token format');
  const header = JSON.parse(decodeBase64Url(parts[0]).toString('utf8')) as { alg?: string; kid?: string };
  const payload = JSON.parse(decodeBase64Url(parts[1]).toString('utf8')) as Record<string, unknown>;

  // 卫生：header 只露 alg/kid/typ；payload 只露键名（含 sub/email 等个人信息）
  log.debug('id_token header', { alg: header.alg, kid: header.kid });
  log.debug('id_token payload', { keys: Object.keys(payload), issuer: payload.iss, audience: payload.aud });
  log.debug('Expected issuer', { issuer: config.issuer });
  log.debug('Expected clientId', { clientId: config.clientId });
  log.debug('JWKS URI', { jwksUri: config.jwksUri });

  if (!header.alg || !header.kid) throw new Error('id_token missing alg or kid');

  const jwksResp = await fetch(config.jwksUri);
  log.debug('JWKS fetch status', { status: jwksResp.status });
  if (!jwksResp.ok) throw new Error(`JWKS fetch failed: HTTP ${jwksResp.status}`);
  const jwks = await jwksResp.json() as { keys?: Array<Record<string, unknown>> };
  log.debug('JWKS keys count', { count: jwks.keys?.length });
  log.debug('JWKS keys', { keys: jwks.keys?.map(k => ({ kid: k.kid, alg: k.alg, kty: k.kty })) });

  const jwk = (jwks.keys || []).find((key) => String(key.kid || '') === header.kid);
  log.debug('Matched JWK', { jwk: jwk ? { kid: jwk.kid, alg: jwk.alg, kty: jwk.kty } : 'NOT FOUND' });
  if (!jwk) throw new Error('Unable to find matching JWKS key for id_token');

  const verifyAlgMap: Record<string, string> = {
    RS256: 'RSA-SHA256',
    RS384: 'RSA-SHA384',
    RS512: 'RSA-SHA512',
    ES256: 'sha256',
    ES384: 'sha384',
    ES512: 'sha512',
  };
  const verifyAlg = verifyAlgMap[header.alg];
  log.debug('Using verify algorithm', { verifyAlg });
  if (!verifyAlg) throw new Error(`Unsupported id_token algorithm: ${header.alg}`);
  const publicKey = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
  const signingInput = `${parts[0]}.${parts[1]}`;
  let signature = decodeBase64Url(parts[2]);
  log.debug('Original signature length', { length: signature.length });

  if (header.alg.startsWith('ES') && jwk.kty === 'EC') {
    const keySize = header.alg === 'ES256' ? 32 : header.alg === 'ES384' ? 48 : 66;
    if (signature.length === keySize * 2) {
      const r = signature.slice(0, keySize);
      const s = signature.slice(keySize);
      signature = ellipticSigToDer(r, s);
      log.debug('Converted ECDSA signature to DER format', { newLength: signature.length });
    }
  }

  const ok = crypto.verify(verifyAlg, Buffer.from(signingInput), publicKey, signature);
  log.debug('Signature verification result', { ok });
  if (!ok) throw new Error('id_token signature verification failed');

  const now = Math.floor(Date.now() / 1000);
  const exp = Number(payload.exp || 0);
  if (exp && exp < now) throw new Error('id_token expired');
  if (payload.aud && payload.aud !== config.clientId && !(Array.isArray(payload.aud) && payload.aud.includes(config.clientId))) {
    throw new Error('id_token audience mismatch');
  }
  if (config.issuer && payload.iss && payload.iss !== config.issuer) {
    throw new Error('id_token issuer mismatch');
  }
  return payload;
}

/**
 * @swagger
 * /api/auth/public-key:
 *   get:
 *     summary: Get RSA public key for password encryption
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: RSA public key in PEM format
 */
router.get('/public-key', (req: Request, res: Response) => {
  try {
    const keyPair = getOrGenerateRSAKeyPair();
    res.json({
      code: 0,
      data: { publicKey: keyPair.publicKey },
      msg: 'success'
    });
  } catch (error) {
    log.error('Failed to generate public key', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ code: 500, msg: 'Failed to generate public key' });
  }
});

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Login with username/email and password
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, password]
 *             properties:
 *               username:
 *                 type: string
 *                 description: Username or email address
 *               password:
 *                 type: string
 *                 description: Password (can be encrypted with RSA public key)
 *               encrypted:
 *                 type: boolean
 *                 description: Whether the password is encrypted
 *     responses:
 *       200:
 *         description: JWT token returned
 */
router.post('/login', loginLimiter, async (req: Request, res: Response) => {
  const { username, password, totpCode, backupCode, webauthnResponse, trustDevice, encrypted } = req.body as {
    username: string;
    password: string;
    totpCode?: string;
    backupCode?: string;
    webauthnResponse?: any;
    trustDevice?: boolean;
    encrypted?: boolean;
  };
  if (!username || !password) {
    sendError(res, 'Username/email and password are required', 400);
    return;
  }

  try {
    // Decrypt password if encrypted
    let actualPassword = password;
    if (encrypted) {
      try {
        actualPassword = decryptPassword(password);
        log.debug('Password decrypted successfully');
      } catch (decryptError) {
        log.warn('Failed to decrypt password, using as-is', { error: decryptError instanceof Error ? decryptError.message : String(decryptError) });
        // If decryption fails, continue with the original password (backward compatibility)
      }
    }

    // Check if input is an email (contains @)
    const isEmail = username.includes('@');

    // Get the identifier for login limit check (use username if found, otherwise use the input)
    let loginIdentifier = username.toLowerCase();

    // Check login limit
    // 账号锁/限流必须用真实 TCP 对端地址：TRUST_PROXY=true 时 req.ip 可被 X-Forwarded-For 伪造，
    // 伪造头即可无限重试（第四轮 P2）。
    const ipAddress = req.socket?.remoteAddress ?? getRequestIP(req);
    const limitCheck = await checkLoginAllowed(loginIdentifier, ipAddress);
    if (!limitCheck.allowed) {
      sendError(res, limitCheck.message || 'Account is temporarily locked', 429);
      return;
    }

    let user: User | undefined;
    if (isEmail) {
      // Login with email
      user = await UserOperations.getByEmail(username) as User | undefined;
    } else {
      // Login with username
      user = await UserOperations.getByUsername(username) as User | undefined;
    }

    // Timing attack prevention: always execute bcrypt to maintain constant response time
    const fakeHash = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'; // Fixed dummy hash
    const passwordMatch = user
      ? bcrypt.compareSync(actualPassword, user.password_hash)
      : bcrypt.compareSync(actualPassword, fakeHash);

    if (!passwordMatch || !user) {
      // Record failed attempt
      const failedResult = await recordFailedAttempt(loginIdentifier, ipAddress);
      if (failedResult.locked) {
        sendError(res, failedResult.message || 'Account is temporarily locked', 429);
      } else {
        sendError(res, `Invalid username/email or password. ${failedResult.message || ''}`.trim(), 401);
      }
      return;
    }

    // At this point, user is guaranteed to exist and password matches
    // Use non-null assertion to satisfy TypeScript
    const authenticatedUser = user!;
    if (authenticatedUser.status === 0) {
      sendError(res, 'Account is disabled', 403);
      return;
    }

    const securityPolicy = await getSecurityPolicy();
    // 全局策略只决定「是否强制所有人必须开」，不决定「已开启的人是否要校验」：
    // 用户自己开了 TOTP/Passkey，登录就必须验第二因子，否则 2FA 形同虚设。
    const twoFAValidationEnabled = Boolean(securityPolicy.require2FAGlobal);

    // Check 2FA
    const totpStatus = await getTOTPStatus(authenticatedUser.id);
    const isWebauthnEnabled = await TwoFAOperations.isWebAuthnEnabled(authenticatedUser.id);
    const isTotpEnabled = totpStatus.enabled;
    const has2FA = isTotpEnabled || isWebauthnEnabled;

    // 检查是否需要强制 2FA
    const force2FA = twoFAValidationEnabled && (await requires2FA(authenticatedUser.id));
    const userHas2FA = await has2FAEnabled(authenticatedUser.id);

    // 如果强制 2FA 但用户未设置，要求先设置 2FA
    if (force2FA && !userHas2FA) {
      res.json({
        code: -3,
        msg: '2FA setup required',
        data: { require2FASetup: true }
      });
      return;
    }

    if (has2FA) {
      if (backupCode) {
        const isValid = await verifyBackupCode(authenticatedUser.id, backupCode);
        if (!isValid) {
          sendError(res, 'Invalid backup code', 401);
          return;
        }
      } else if (totpCode && isTotpEnabled) {
        const secret = await TwoFAOperations.getTOTPSecret(authenticatedUser.id);
        if (!secret || !verifyTOTPToken(secret, totpCode)) {
          sendError(res, 'Invalid 2FA code', 401);
          return;
        }
      } else if (webauthnResponse && isWebauthnEnabled) {
        // webauthnResponse verification is handled by another endpoint or we verify it here
        const expectedChallenge = (global as any).loginChallengeStore?.get(authenticatedUser.id);
        if (!expectedChallenge) {
          sendError(res, 'WebAuthn challenge expired or missing', 400);
          return;
        }

        const { verifyAuthenticationResponse } = require('@simplewebauthn/server');
        const { getUserWebAuthnCredentials, updateWebAuthnCredentialCounter } = require('../service/webauthn');
        const userCreds = await getUserWebAuthnCredentials(authenticatedUser.id);
        const cred = userCreds.find((c: any) => c.id === webauthnResponse.id);
        if (!cred) {
          sendError(res, 'Credential not found', 404);
          return;
        }

        try {
          const webAuthn = resolveWebAuthnConfig(req);
        const verification = await verifyAuthenticationResponse({
            response: webauthnResponse,
            expectedChallenge,
            expectedOrigin: webAuthn.origin,
            expectedRPID: webAuthn.rpID,
            authenticator: {
              credentialID: cred.id,
              credentialPublicKey: Buffer.from(cred.public_key, 'base64'),
              counter: cred.counter,
              transports: cred.transports,
            },
          });

          if (!verification.verified) {
            sendError(res, 'WebAuthn verification failed', 401);
            return;
          }
          await updateWebAuthnCredentialCounter(cred.id, verification.authenticationInfo.newCounter);
          (global as any).loginChallengeStore.delete(authenticatedUser.id);
        } catch (e: any) {
          sendError(res, e.message, 400);
          return;
        }
      } else {
        // 2FA required
        const types = [];
        if (isTotpEnabled) types.push('totp');
        if (isWebauthnEnabled) types.push('webauthn');
        res.json({ code: -2, msg: '2FA required', data: { require2FA: true, types } });
        return;
      }
    }

    // Clear login attempts on successful login
    await clearLoginAttempts(loginIdentifier, ipAddress);

    // 如果用户选择信任设备，添加设备信任
    let deviceId: string | undefined;
    if (trustDevice && twoFAValidationEnabled && has2FA) {
      const deviceInfo: DeviceInfo = {
        userAgent: req.headers['user-agent'] || '',
        ipAddress: getRequestIP(req),
      };
      deviceId = await addTrustedDevice(authenticatedUser.id, deviceInfo);
    }

    const token = await signToken({ userId: authenticatedUser.id, username: authenticatedUser.username, nickname: authenticatedUser.nickname, role: authenticatedUser.role });

    // Set httpOnly cookie (secure, XSS-proof)
    setAuthCookie(res, token);

    res.json({
      code: 0,
      data: {
        user: { id: authenticatedUser.id, username: authenticatedUser.username, nickname: authenticatedUser.nickname, email: authenticatedUser.email, role: authenticatedUser.role },
        deviceId,
        require2FASetup: force2FA && !userHas2FA,
      },
      msg: 'success',
    });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Login failed' });
  }
});

/**
 * @swagger
 * /api/auth/oauth/status:
 *   get:
 *     summary: Get OAuth configuration status
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: OAuth status returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: number
 *                 data:
 *                   type: object
 *                   properties:
 *                     enabled:
 *                       type: boolean
 *                     providerName:
 *                       type: string
 *                     providers:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           key:
 *                             type: string
 *                           providerName:
 *                             type: string
 *                 msg:
 *                   type: string
 */
router.get('/oauth/status', async (_req: Request, res: Response) => {
  try {
    const providers = await getEnabledOAuthProviders();
    res.json({
      code: 0,
      data: { enabled: providers.length > 0, providerName: providers[0]?.providerName || 'OIDC', providers },
      msg: 'success'
    });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to get oauth status' });
  }
});

/**
 * @swagger
 * /api/auth/oauth/start:
 *   post:
 *     summary: Start OAuth login flow
 *     tags: [Auth]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               provider:
 *                 type: string
 *                 enum: ['custom', 'logto']
 *                 default: 'custom'
 *     responses:
 *       200:
 *         description: OAuth authorization URL returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: number
 *                 data:
 *                   type: object
 *                   properties:
 *                     authUrl:
 *                       type: string
 *                 msg:
 *                   type: string
 *       400:
 *         description: OAuth not enabled or configuration error
 */
router.post('/oauth/start', async (req: Request, res: Response) => {
  try {
    // 未显式传 provider 时，回落到「第一个已启用」的提供商；
    // 历史实现固定 'custom'，只启用 Logto 的部署会误报 OAuth login is disabled。
    const requested = req.body?.provider as 'custom' | 'logto' | undefined;
    const enabled = await getEnabledOAuthProviders();
    const desired = pickOAuthProvider(requested, enabled);
    const config = await getOAuthConfigByProvider(desired);
    assertOAuthEnabled(config);

    // Force redirectUri to use the fixed callback endpoint
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const baseUrl = `${protocol}://${host}`;
    config.redirectUri = `${baseUrl}/oauth/callback`;

    const state = randomHex(24);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await OAuthOperations.createState(state, 'login', desired, null, expiresAt);
    log.debug('State created for login', { state: state.substring(0, 10) + '...', provider: desired, expiresAt: expiresAt.toISOString() });
    res.json({ code: 0, data: { authUrl: buildOauthAuthUrl(config, state) }, msg: 'success' });
  } catch (error) {
    res.status(400).json({ code: 400, msg: error instanceof Error ? error.message : 'Failed to start oauth flow' });
  }
});

/**
 * @swagger
 * /api/auth/oauth/start-bind:
 *   post:
 *     summary: Start OAuth bind flow for current user
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               provider:
 *                 type: string
 *                 enum: ['custom', 'logto']
 *                 default: 'custom'
 *     responses:
 *       200:
 *         description: OAuth authorization URL returned
 *       400:
 *         description: OAuth not enabled
 *       401:
 *         description: Unauthorized
 */
router.post('/oauth/start-bind', authMiddleware, async (req: Request, res: Response) => {
  // 最早期日志，确认请求到达
  // 卫生：只记字段名，避免将来 body 里加了敏感字段就被整包落盘
  log.debug('>>> /oauth/start-bind ENTRY', { userId: req.user?.userId, bodyKeys: Object.keys(req.body ?? {}) });
  try {
    const desired = (req.body?.provider as 'custom' | 'logto' | undefined) || 'custom';
    log.debug('Start bind request received', { provider: desired, userId: req.user!.userId });

    const config = await getOAuthConfigByProvider(desired);
    assertOAuthEnabled(config);

    // Force redirectUri to use the fixed callback endpoint
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const baseUrl = `${protocol}://${host}`;
    config.redirectUri = `${baseUrl}/oauth/callback`;

    const state = randomHex(24);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await OAuthOperations.createState(state, 'bind', desired, req.user!.userId, expiresAt);
    log.debug('State created for bind', {
      state: state.substring(0, 16) + '...',
      provider: desired,
      userId: req.user!.userId,
      expiresAt: expiresAt.toISOString()
    });
    res.json({ code: 0, data: { authUrl: buildOauthAuthUrl(config, state) }, msg: 'success' });
  } catch (error) {
    log.error('Failed to start bind', { error: error instanceof Error ? error.message : String(error) });
    res.status(400).json({ code: 400, msg: error instanceof Error ? error.message : 'Failed to start oauth bind flow' });
  }
});

/**
 * @swagger
 * /api/auth/oauth/callback:
 *   post:
 *     summary: OAuth callback endpoint
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - code
 *               - state
 *             properties:
 *               code:
 *                 type: string
 *                 description: Authorization code from OAuth provider
 *               state:
 *                 type: string
 *                 description: State parameter for CSRF protection
 *     responses:
 *       200:
 *         description: Login successful or bind successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: number
 *                 data:
 *                   type: object
 *                   properties:
 *                     mode:
 *                       type: string
 *                       enum: ['login', 'bind']
 *                     token:
 *                       type: string
 *                     user:
 *                       type: object
 *                 msg:
 *                   type: string
 *       400:
 *         description: Invalid parameters or expired state
 *       403:
 *         description: Account not bound or disabled
 */
router.post('/oauth/callback', async (req: Request, res: Response) => {
  const { code, state } = req.body as { code?: string; state?: string };
  log.debug('Callback received', { code: code?.substring(0, 16) + '...', state: state?.substring(0, 16) + '...' });

  if (!code || !state) {
    log.warn('Missing code or state', { hasCode: !!code, hasState: !!state });
    res.status(400).json({ code: 400, msg: 'code and state are required' });
    return;
  }

  // 检查是否正在处理相同的回调（防止重复请求）
  const callbackKey = `${code}:${state}`;
  if (processingCallbacks.has(callbackKey)) {
    log.warn('Duplicate callback detected, ignoring', { state: state.substring(0, 16) + '...' });
    res.status(429).json({ code: 429, msg: 'Callback is being processed, please wait' });
    return;
  }

  processingCallbacks.add(callbackKey);

  try {
    log.debug('State store lookup', { lookingFor: state.substring(0, 16) + '...' });

    // 从数据库获取并删除 state（一次性使用）
    const stateEntry = await OAuthOperations.getAndDeleteState(state);

    if (!stateEntry) {
      log.warn('State not found in store', { state: state.substring(0, 16) + '...', code: code?.substring(0, 16) + '...' });

      // 检查这个code是否已经被处理过
      const processedTimestamp = processedCodes.get(code);
      if (processedTimestamp && Date.now() - processedTimestamp <= PROCESSED_CODES_TTL) {
        log.info('Code already processed, returning success', { code: code?.substring(0, 16) + '...' });
        // 如果已经处理过，返回成功（幂等性）
        // 对于绑定模式，返回成功
        // 对于登录模式，需要检查用户是否已经登录，但这里简单返回成功
        addProcessedCode(code); // 确保记录code（虽然已经存在，但更新访问时间）
        res.json({ code: 0, data: { mode: 'login' }, msg: 'OAuth flow already completed' });
        return;
      }

      // 可能正在处理中，等待一小段时间后重试
      log.info('State not found but may be processing, waiting...', { state: state.substring(0, 16) + '...' });

      // 等待1秒，让第一个请求有机会完成
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 再次检查是否已经被处理
      const processedTimestamp2 = processedCodes.get(code);
      if (processedTimestamp2 && Date.now() - processedTimestamp2 <= PROCESSED_CODES_TTL) {
        log.info('Code processed after waiting, returning success', { code: code?.substring(0, 16) + '...' });
        addProcessedCode(code);
        res.json({ code: 0, data: { mode: 'login' }, msg: 'OAuth flow completed after retry' });
        return;
      }

      res.status(400).json({ code: 400, msg: 'Invalid oauth state - state not found. Server may have restarted or callback was already processed.' });
      return;
    }

    log.debug('State found and removed', { state: state.substring(0, 16) + '...' });

    if (new Date() > stateEntry.expiresAt) {
      log.warn('State expired', { state: state.substring(0, 16) + '...', expiredAt: stateEntry.expiresAt.toISOString() });
      res.status(400).json({ code: 400, msg: 'Expired oauth state' });
      return;
    }

    log.debug('State validated', { mode: stateEntry.mode, provider: stateEntry.provider, userId: stateEntry.userId });

    // 处理成功后立即清理标记（后续代码可能耗时较长）
    processingCallbacks.delete(callbackKey);

    const config = await getOAuthConfigByProvider(stateEntry.provider);
    assertOAuthEnabled(config);
    const provider = stateEntry.provider;

    // Force redirectUri to use the fixed callback endpoint
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const baseUrl = `${protocol}://${host}`;
    config.redirectUri = `${baseUrl}/oauth/callback`;

    const tokenResult = await exchangeOauthCode(config, code);
    const profile = await fetchOAuthProfile(config, tokenResult.accessToken);
    // ID Token 验证（可选，失败不阻断流程）
    let idTokenClaims: OAuthUserProfile = {};
    if (tokenResult.idToken) {
      try {
        idTokenClaims = await verifyIdToken(tokenResult.idToken, config);
      } catch (idTokenError) {
        log.warn('ID Token verification failed, continuing with profile only', { error: idTokenError instanceof Error ? idTokenError.message : String(idTokenError) });
      }
    }
    const mergedProfile = { ...idTokenClaims, ...profile };
    const subject = resolveOAuthSubject(config, mergedProfile);
    const normalizedEmail = resolveOAuthEmail(config, mergedProfile);

    // Get provider key for database lookup
    const providerKey = getProviderKey(config);

    const existingLink = await OAuthOperations.getUserByProviderSubject(providerKey, subject);

    if (stateEntry.mode === 'bind') {
      const currentUserId = stateEntry.userId;
      if (!currentUserId) {
        res.status(401).json({ code: 401, msg: 'Unauthorized' });
        return;
      }
      if (existingLink && existingLink.id !== currentUserId) {
        res.status(409).json({ code: 409, msg: 'This OAuth account is already bound to another user' });
        return;
      }
      if (existingLink && existingLink.id === currentUserId) {
        addProcessedCode(code);
        res.json({ code: 0, data: { mode: 'bind' }, msg: 'success' });
        return;
      }
      await OAuthOperations.create(currentUserId, providerKey, subject, normalizedEmail);
      await logAuditOperation(currentUserId, 'bind_oauth_account', 'system', { provider: providerKey, subject, email: normalizedEmail });
      addProcessedCode(code);
      res.json({ code: 0, data: { mode: 'bind' }, msg: 'success' });
      return;
    }

    const user = existingLink as LoginUserInfo | undefined;

    if (!user) {
      res.status(403).json({ code: 403, msg: 'OAuth account is not bound. Please bind it in account settings first.' });
      return;
    }
    if (user.status === 0) {
      res.status(403).json({ code: 403, msg: 'Account is disabled' });
      return;
    }

    const token = await signToken({ userId: user.id, username: user.username, nickname: user.nickname, role: user.role });

    // Set httpOnly cookie (secure, XSS-proof)
    setAuthCookie(res, token);

    await logAuditOperation(user.id, 'oauth_login', 'system', { provider: providerKey });
    addProcessedCode(code);
    res.json({
      code: 0,
      data: { mode: 'login', user: { id: user.id, username: user.username, nickname: user.nickname, email: user.email, role: user.role } },
      msg: 'success',
    });
  } catch (error) {
    log.error('Callback processing failed', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'OAuth callback failed' });
  } finally {
    // 清理处理标记
    processingCallbacks.delete(`${code}:${state}`);
  }
});

router.get('/oauth/bindings', authMiddleware, async (req: Request, res: Response) => {
  try {
    const list = await OAuthOperations.getByUserId(req.user!.userId);
    res.json({ code: 0, data: list, msg: 'success' });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to get oauth bindings' });
  }
});

router.delete('/oauth/bindings/:provider', authMiddleware, async (req: Request, res: Response) => {
  try {
    const provider = (req.params.provider || '').trim().toLowerCase();
    if (!provider) {
      res.status(400).json({ code: 400, msg: 'provider is required' });
      return;
    }
    await OAuthOperations.delete(req.user!.userId, provider);
    await logAuditOperation(req.user!.userId, 'unbind_oauth_account', 'system', { provider });
    res.json({ code: 0, msg: 'success' });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to unbind oauth account' });
  }
});

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     summary: Get current user info
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current user info
 */
router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = await UserOperations.getPublicById(req.user!.userId);

    if (!user) {
      sendError(res, 'User not found', 404);
      return;
    }
    res.json({ code: 0, data: user, msg: 'success' });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to get user info' });
  }
});

/**
 * @swagger
 * /api/auth/password:
 *   put:
 *     summary: Change current user password
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [oldPassword, newPassword]
 *             properties:
 *               oldPassword:
 *                 type: string
 *               newPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: Password changed
 */
router.put('/password', authMiddleware, async (req: Request, res: Response) => {
  const { oldPassword, newPassword, encrypted } = req.body as {
    oldPassword: string;
    newPassword: string;
    encrypted?: boolean;
  };
  if (!oldPassword || !newPassword) {
    sendError(res, 'Old and new passwords are required', 400);
    return;
  }

  try {
    // Decrypt passwords if encrypted
    let actualOldPassword = oldPassword;
    let actualNewPassword = newPassword;

    if (encrypted) {
      try {
        actualOldPassword = decryptPassword(oldPassword);
        actualNewPassword = decryptPassword(newPassword);
        log.debug('Passwords decrypted successfully for password change');
      } catch (decryptError) {
        log.warn('Failed to decrypt passwords, using as-is', {
          error: decryptError instanceof Error ? decryptError.message : String(decryptError)
        });
      }
    }

    const user = await UserOperations.getById(req.user!.userId);

    if (!user || !bcrypt.compareSync(actualOldPassword, user.password_hash as string)) {
      sendError(res, 'Old password is incorrect', 401);
      return;
    }

    // 验证新密码强度
    const passwordCheck = await validatePassword(actualNewPassword);
    if (!passwordCheck.valid) {
      sendError(res, passwordCheck.message!, 400);
      return;
    }

    const hash = bcrypt.hashSync(actualNewPassword, 10);

    await UserOperations.updatePassword(user.id as number, hash);

    // 修改密码后清除所有受信任设备
    const { removeAllUserTrustedDevices } = require('../service/deviceTrust');
    await removeAllUserTrustedDevices(user.id as number);

    res.json({ code: 0, msg: 'success' });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to change password' });
  }
});

/**
 * @swagger
 * /api/auth/profile:
 *   put:
 *     summary: Update current user profile
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nickname:
 *                 type: string
 *               email:
 *                 type: string
 *     responses:
 *       200:
 *         description: Profile updated
 */
// 账号级写（改名/改邮箱→可触发密码重置）必须 JWT：令牌不应能改账号资料
router.put('/profile', authMiddleware, noTokenAuth('account profile'), async (req: Request, res: Response) => {
  const { nickname, email, emailCode } = req.body as { nickname?: string; email?: string; emailCode?: string };
  if (nickname === undefined && email === undefined) {
    sendSuccess(res, null, 'Nothing to update');
    return;
  }

  try {
    const user = await UserOperations.getById(req.user!.userId);

    if (!user) {
      sendError(res, 'User not found', 404);
      return;
    }

    const updates: Record<string, unknown> = {};

    if (nickname !== undefined) {
      updates.nickname = nickname.trim() || user.username;
    }
    if (email !== undefined) {
      const nextEmail = email.trim();
      if (nextEmail !== user.email) {
        if (!emailCode || !verifyEmailVerificationCode(user.id as number, nextEmail, emailCode)) {
          res.status(400).json({ code: 400, msg: 'Valid email verification code is required' });
          return;
        }
      }
      updates.email = nextEmail;
    }

    await UserOperations.update(user.id as number, updates);
    const updatedResult = await UserOperations.getPublicById(user.id as number);
    if (email !== undefined && email.trim() !== user.email) {
      await logAuditOperation(user.id as number, 'update_profile_email', 'system', { oldEmail: user.email, newEmail: email.trim() });
    }
    res.json({ code: 0, data: updatedResult, msg: 'success' });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to update profile' });
  }
});

router.post('/profile/email-code', authMiddleware, emailLimiter, async (req: Request, res: Response) => {
  const { email } = req.body as { email?: string };
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized) {
    res.status(400).json({ code: 400, msg: 'Email is required' });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    res.status(400).json({ code: 400, msg: 'Invalid email format' });
    return;
  }
  try {
    await sendEmailVerificationCode(req.user!.userId, normalized);
    await logAuditOperation(req.user!.userId, 'send_email_verification_code', 'system', { email: normalized });
    res.json({ code: 0, msg: 'success' });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to send verification code' });
  }
});

router.post('/password-reset/request', async (req: Request, res: Response) => {
  const { email } = req.body as { email?: string };
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized) {
    res.status(400).json({ code: 400, msg: 'Email is required' });
    return;
  }
  try {
    const smtpCfg = await getSmtpConfig();
    if (!smtpCfg.enabled) {
      res.status(400).json({ code: 400, msg: 'Password reset by email is unavailable: SMTP is not configured' });
      return;
    }
    const user = await UserOperations.getByEmail(normalized);
    if (user) {
      // Use cryptographically secure random number for reset code
      const code = String(crypto.randomInt(100000, 999999));
      await db.PasswordReset.upsertCode(normalized, code, Date.now() + 10 * 60 * 1000);
      await sendSmtpEmail(normalized, 'HiDNS Password Reset Code', `Hi ${user.username},\n\nYour password reset code is: ${code}\nThis code will expire in 10 minutes.`);
      await logAuditOperation(user.id as number, 'send_password_reset_code', 'system', { email: normalized });
    }
    res.json({ code: 0, msg: 'success' });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to send password reset code' });
  }
});

router.post('/password-reset/confirm', async (req: Request, res: Response) => {
  const { email, code, newPassword, encrypted } = req.body as {
    email?: string;
    code?: string;
    newPassword?: string;
    encrypted?: boolean;
  };
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized || !code || !newPassword) {
    res.status(400).json({ code: 400, msg: 'Email, code and newPassword are required' });
    return;
  }

  // Decrypt password if encrypted
  let actualNewPassword = newPassword;
  if (encrypted) {
    try {
      actualNewPassword = decryptPassword(newPassword);
      log.debug('Password decrypted successfully for reset');
    } catch (decryptError) {
      log.warn('Failed to decrypt password, using as-is', {
        error: decryptError instanceof Error ? decryptError.message : String(decryptError)
      });
    }
  }

  if (actualNewPassword.length < 6) {
    res.status(400).json({ code: 400, msg: 'Password must be at least 6 characters' });
    return;
  }
  const entry = await db.PasswordReset.getCode(normalized);
  if (!entry || entry.code !== code.trim() || Date.now() > entry.expiresAt) {
    res.status(400).json({ code: 400, msg: 'Invalid or expired reset code' });
    return;
  }
  try {
    // Don't check user existence separately to avoid leaking information
    // If the code is valid but user was deleted, just fail silently
    const user = await UserOperations.getByEmail(normalized);
    if (user) {
      const hash = bcrypt.hashSync(actualNewPassword, 10);
      await UserOperations.updatePassword(user.id as number, hash);
      await logAuditOperation(user.id as number, 'reset_password_by_email', 'system', { email: normalized });
    }
    // Always delete the code regardless of whether user exists
    await db.PasswordReset.deleteCode(normalized);
    res.json({ code: 0, msg: 'success' });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to reset password' });
  }
});

/**
 * @swagger
 * /api/auth/preferences:
 *   get:
 *     summary: Get current user preferences
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User preferences
 */
router.get('/preferences', authMiddleware, async (req: Request, res: Response) => {
  try {
    const preferences = await getUserPreferences(req.user!.userId);
    res.json({
      code: 0,
      data: {
        theme: preferences.theme,
        language: preferences.language,
        notificationsEnabled: preferences.notificationsEnabled,
        emailNotifications: preferences.emailNotifications,
        backgroundImage: preferences.backgroundImage,
        avatarImage: preferences.avatarImage,
      },
      msg: 'success',
    });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to get preferences' });
  }
});

/**
 * @swagger
 * /api/auth/preferences:
 *   put:
 *     summary: Update current user preferences
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               theme:
 *                 type: string
 *                 enum: ['light', 'dark', 'auto']
 *               language:
 *                 type: string
 *               notificationsEnabled:
 *                 type: boolean
 *               emailNotifications:
 *                 type: boolean
 *               backgroundImage:
 *                 type: string
 *                 description: Custom background image URL
 *               avatarImage:
 *                 type: string
 *                 description: Custom avatar image URL
 *     responses:
 *       200:
 *         description: Preferences updated
 */
router.put('/preferences', authMiddleware, async (req: Request, res: Response) => {
  const { theme, language, notificationsEnabled, emailNotifications, backgroundImage, avatarImage } = req.body as Partial<UserPreferences>;

  try {
    const updates: Partial<UserPreferences> = {};
    if (theme !== undefined) updates.theme = theme;
    if (language !== undefined) updates.language = language;
    if (notificationsEnabled !== undefined) updates.notificationsEnabled = notificationsEnabled;
    if (emailNotifications !== undefined) updates.emailNotifications = emailNotifications;
    if (backgroundImage !== undefined) updates.backgroundImage = backgroundImage;
    if (avatarImage !== undefined) updates.avatarImage = avatarImage;

    await updateUserPreferences(req.user!.userId, updates);
    await logAuditOperation(req.user!.userId, 'update_preferences', 'system', updates);
    res.json({ code: 0, msg: 'success' });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to update preferences' });
  }
});

/**
 * Get user's pinned domains
 */
router.get('/preferences/pinned-domains', authMiddleware, async (req: Request, res: Response) => {
  try {
    const pinnedDomains = await UserPreferencesOperations.getPinnedDomains(req.user!.userId);
    res.json({ code: 0, data: { pinnedDomains } });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to get pinned domains' });
  }
});

/**
 * Update user's pinned domains
 */
router.put('/preferences/pinned-domains', authMiddleware, async (req: Request, res: Response) => {
  const { domainIds } = req.body as { domainIds?: number[] };

  if (!Array.isArray(domainIds)) {
    res.status(400).json({ code: 400, msg: 'domainIds must be an array' });
    return;
  }

  try {
    // ← 新增：检查是否有同名域名已经置顶
    if (domainIds.length > 0) {
      // 获取所有要置顶的域名信息
      const domainsToPin = await DomainOperations.getByIds(domainIds);

      // 构建域名名称到 ID 的映射
      const nameToIdMap = new Map<string, number>();
      const duplicateNames: string[] = [];

      for (const domain of domainsToPin) {
        const domainName = (domain as any).name || (domain as any).full_domain;
        const domainId = Number((domain as any).id);
        if (!domainName || !domainId) continue;

        if (nameToIdMap.has(domainName)) {
          // 发现同名域名
          duplicateNames.push(domainName);
        } else {
          nameToIdMap.set(domainName, domainId);
        }
      }

      // 如果有重复的域名名称，返回错误
      if (duplicateNames.length > 0) {
        res.status(400).json({
          code: 400,
          msg: `Duplicate domain names found: ${duplicateNames.join(', ')}. Cannot pin multiple domains with the same name.`
        });
        return;
      }
    }

    await UserPreferencesOperations.updatePinnedDomains(req.user!.userId, domainIds);

    // ← 发送 WebSocket 通知，刷新前端域名列表
    const wsService = require('../service/websocket').wsService;
    wsService.sendToUser(req.user!.userId, {
      type: 'pinned_domains_updated',
      data: { domainIds },
      timestamp: new Date().toISOString()
    });

    res.json({ code: 0, msg: 'success' });
  } catch (error) {
    res.status(500).json({ code: 500, msg: error instanceof Error ? error.message : 'Failed to update pinned domains' });
  }
});

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Logout and clear auth cookie
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Successfully logged out
 */
router.post('/logout', authMiddleware, (req: Request, res: Response) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: getClientProtocol(req) === 'https',
    sameSite: 'strict',
    path: '/',
  });

  res.json({ code: 0, msg: 'Logged out successfully' });
});

export default router;
