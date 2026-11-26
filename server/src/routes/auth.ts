import { Router, Request, Response } from 'express';
import { resolveWebAuthnConfig } from './webauthn';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { authMiddleware, noTokenAuth } from '../middleware/auth';
import { signToken, signEmailVerifyPendingToken, verifyEmailVerifyPendingToken, signOAuth2FAPendingToken, verifyOAuth2FAPendingToken } from '../service/jwt';
import { EMAIL_MAX_LENGTH, isValidEmail } from '../utils/validation';
// 必须走 import 而不是 require：require 解构出来是 any，v10 → v13 的参数改名
// （authenticator → credential）在 tsc 阶段完全看不见，只能等运行时 TypeError（issue #64）。
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { getUserWebAuthnCredentials, updateWebAuthnCredentialCounter } from '../service/webauthn';
import { User } from '../types';
import { checkLoginAllowed, recordFailedAttempt, clearLoginAttempts } from '../service/loginLimit';
import { sendEmailVerificationCode, verifyEmailVerificationCode } from '../service/emailVerification';
import { logAuditOperation } from '../service/audit';
import { getSmtpConfig, sendSmtpEmail } from '../service/smtp';
import { getUserPreferences, updateUserPreferences, UserPreferences } from '../service/userPreferences';
import { loginLimiter, emailLimiter, emailVerifyLimiter, oauth2faLimiter } from '../middleware/rateLimit';
import { getTOTPStatus, verifyTOTPToken, verifyBackupCode } from '../service/totp';
import { createLogger } from '../lib/logger';
import { UserOperations, OAuthOperations, TwoFAOperations, SettingsOperations, UserPreferencesOperations, DomainOperations } from '../db/bal/business-adapter';
import { requires2FA, has2FAEnabled, validatePassword, getSecurityPolicy, SecurityPolicy } from '../service/securityPolicy';
import { verifyTrustedDevice, addTrustedDevice, DeviceInfo } from '../service/deviceTrust';
import { getRequestIP } from '../middleware/clientIP';
import db from '../db/bal/business-adapter';
import { sendError, sendInternalError, sendSuccess } from '../utils/http';

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

/**
 * 是否需要「登录后验证邮箱」（产品口径：未验证邮箱的非超管用户必须验证一次）。
 * 抽成函数供密码登录与 OAuth 登录共用，避免两条路径口径分叉。
 */
/** OAuth 登录是否要求 2FA：由系统设置里的 requireOAuth2FA 决定（默认不要求） */
async function shouldRequireOAuth2FA(): Promise<boolean> {
  try {
    const raw = await SettingsOperations.get('security_config');
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { requireOAuth2FA?: boolean };
    return Boolean(parsed.requireOAuth2FA);
  } catch {
    // fail-closed：管理员显式开启后，配置损坏或读库抖动不应静默退化为「不要求 2FA」
    return true;
  }
}

async function shouldRequireEmailVerification(user: { email?: string; email_verified?: number; role_level?: number }): Promise<boolean> {
  if (!user.email) return false;
  if (Number(user.email_verified)) return false;
  if (Number(user.role_level ?? 0) >= 3) return false; // 超级管理员豁免
  // SMTP 没配就别拦：用户收不到码会被永久锁在登录页（策略默认开启，自托管实例常常未配 SMTP）
  try {
    const smtp = await getSmtpConfig();
    if (!smtp.enabled) return false;
  } catch {
    return false;
  }
  try {
    const raw = await SettingsOperations.get('security_config');
    if (!raw) return true;
    const parsed = JSON.parse(raw) as { requireEmailVerification?: boolean };
    return parsed.requireEmailVerification === undefined ? true : Boolean(parsed.requireEmailVerification);
  } catch {
    return true; // 配置损坏时 fail-closed
  }
}
router.post('/login', loginLimiter, async (req: Request, res: Response) => {
  const { username, password, totpCode, backupCode, webauthnResponse, emailCode, trustDevice, encrypted } = req.body as {
    username: string;
    password: string;
    totpCode?: string;
    backupCode?: string;
    emailCode?: string;
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
    // 邮箱验证码作为第二因子（issue #43 C2）：需要已开启且邮箱已验证，否则拿不到码
    const isEmailEnabled = (await TwoFAOperations.isEmailEnabled(authenticatedUser.id))
      && Boolean(authenticatedUser.email)
      && Boolean((authenticatedUser as { email_verified?: number }).email_verified);
    const has2FA = isTotpEnabled || isWebauthnEnabled || isEmailEnabled;

    // 检查是否需要强制 2FA
    const force2FA = twoFAValidationEnabled && (await requires2FA(authenticatedUser.id));
    const userHas2FA = await has2FAEnabled(authenticatedUser.id);

    // 产品口径：用户完全没有配置任何 2FA 时不拦截。
    // 强制策略只约束「已经配置过 2FA 的人必须用」——否则未配置的用户会被自己的设置锁在门外
    // （配置入口在登录后的安全设置里，登录前无法自助完成）。

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
      } else if (emailCode && isEmailEnabled) {
        const valid = await verifyEmailVerificationCode(
          authenticatedUser.id,
          String(authenticatedUser.email),
          emailCode,
          'login',
        );
        if (!valid) {
          sendError(res, 'Invalid email verification code', 401);
          return;
        }
      } else if (webauthnResponse && isWebauthnEnabled) {
        // webauthnResponse verification is handled by another endpoint or we verify it here
        const expectedChallenge = (global as any).loginChallengeStore?.get(authenticatedUser.id);
        if (!expectedChallenge) {
          sendError(res, 'WebAuthn challenge expired or missing', 400);
          return;
        }

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
            // 与 options 的 userVerification: 'preferred' 对齐；库默认 true 会让无 PIN 的安全密钥必然失败
            requireUserVerification: process.env.WEBAUTHN_REQUIRE_UV !== '0',
            // @simplewebauthn/server v13 改名为 credential + publicKey；
            // 沿用 v10 的 authenticator/credentialPublicKey 会让库读到 undefined，
            // 直接抛 TypeError: Cannot read properties of undefined (reading 'counter')
            credential: {
              id: cred.id,
              publicKey: Buffer.from(cred.public_key, 'base64'),
              counter: cred.counter,
              // DB 里存的是 JSON string[]，库要求的是有限的 transport 枚举；
              // 收窄交给运行时（未知值库会忽略），类型上用断言
              transports: cred.transports as unknown as AuthenticatorTransportFuture[],
            },
          });

          if (!verification.verified) {
            sendError(res, 'WebAuthn verification failed', 401);
            return;
          }
          await updateWebAuthnCredentialCounter(cred.id, verification.authenticationInfo.newCounter);
          (global as any).loginChallengeStore.delete(authenticatedUser.id);
        } catch (e) {
          // 库异常原文（如 'User verification required, but user could not be verified'）
          // 不该直接出现在登录页上；记日志、回固定文案。
          log.error('WebAuthn verification failed', { error: e instanceof Error ? e.message : String(e) });
          sendError(res, '通行密钥验证失败，请重试或改用密码登录', 401, { kind: 'webauthn' });
          return;
        }
      } else {
        // 2FA required
        const types = [];
        if (isTotpEnabled) types.push('totp');
        if (isWebauthnEnabled) types.push('webauthn');
        if (isEmailEnabled) types.push('email');
        res.json({ code: -2, msg: '2FA required', data: { require2FA: true, types } });
        return;
      }
    }

    // 密码与 2FA 都已通过：先清失败计数，避免多步流程把配额耗在 429 上
    await clearLoginAttempts(loginIdentifier, ipAddress);

    // 邮箱验证拦截（产品口径：未验证邮箱的用户登录后必须验证一次，超级管理员豁免，
    // 是否启用由系统设置里的 requireEmailVerification 控制）。
    // 放在 2FA 之后：先过第二因子，再补邮箱验证，避免两套挑战相互打断。
    if (await shouldRequireEmailVerification(authenticatedUser as { email?: string; email_verified?: number; role_level?: number })) {
      res.json({
        code: -4,
        msg: 'Email verification required',
        data: {
          requireEmailVerification: true,
          email: authenticatedUser.email,
          // 一次性 pending 凭证：/verify-email 必须携带它，避免「知道用户名 + 拿到码」就能换会话
          pendingToken: await signEmailVerifyPendingToken(Number(authenticatedUser.id), true),
        },
      });
      return;
    }

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
    // /login 是未认证端点，回传 error.message 等于把库结构
    // （no such column / Duplicate entry ... for key）暴露给任何人。
    log.error('Login failed', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ code: 500, msg: '登录失败，请稍后重试' });
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
    sendInternalError(res, error, 'Failed to get oauth status', 500);
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
/**
 * 发送登录用邮箱验证码（第二因子，issue #43 C2）。
 *
 * 防枚举：无论账号是否存在、是否开启邮箱 2FA、发信是否成功，响应都一致。
 */
router.post('/login/email-code', emailLimiter, async (req: Request, res: Response) => {
  try {
    const { username } = req.body as { username?: string };
    if (username) {
      // 与 /login 对齐：含 @ 时按邮箱查，否则按用户名
      const identifier = String(username).trim();
      const user = (identifier.includes('@')
        ? await UserOperations.getByEmail(identifier)
        : await UserOperations.getByUsername(identifier)) as
        | { id?: number; email?: string; email_verified?: number }
        | undefined;
      if (user?.id && user.email) {
        const enabled = await TwoFAOperations.isEmailEnabled(Number(user.id));
        if (enabled && Boolean(user.email_verified)) {
          try {
            await sendEmailVerificationCode(Number(user.id), String(user.email), 'login');
          } catch (error) {
            log.warn('Failed to send login verification code', { error });
          }
        }
      }
    }
    sendSuccess(res, { sent: true }, '如果该账号已开启邮箱验证，验证码会发送到其邮箱');
  } catch (error) {
    sendError(res, error instanceof Error ? error.message : 'Failed to send code', 500);
  }
});


/**
 * 验证当前用户的邮箱（登录后强制验证流程）。
 *
 * 只校验「发到该邮箱的验证码」，不签发 token —— 通过后前端重新走 /login。
 * 不要求密码：验证码本身已经证明邮箱归属。
 */

/**
 * 为「登录后强制验证邮箱」流程发码（未登录可用）。
 *
 * 与 /login/email-code 的区别：
 *   - 不要求 email_verified（正是未验证的人需要它）；
 *   - purpose 固定为 profile，与 /auth/verify-email 的校验口径一致。
 * 防枚举：无论账号是否存在、是否有邮箱，响应一致。
 */

/**
 * 用一次性凭证完成 OAuth 登录的第二因子（OAuth 用户通常没有密码）。
 *
 * 因子与 /login 的 2FA 分支一致：备用码 / TOTP / 通行密钥。
 */
router.post('/oauth/2fa', oauth2faLimiter, async (req: Request, res: Response) => {
  try {
    const { pendingToken, totpCode, backupCode, webauthnResponse, emailCode } = req.body as {
      pendingToken?: string;
      totpCode?: string;
      backupCode?: string;
      emailCode?: string;
      webauthnResponse?: unknown;
    };
    const uid = pendingToken ? await verifyOAuth2FAPendingToken(pendingToken) : null;
    if (!uid) {
      sendError(res, 'Verification expired, please sign in again', 401);
      return;
    }

    const user = await UserOperations.getById(uid) as
      | { id?: number; username?: string; nickname?: string; role?: string; role_level?: number; status?: number; email?: string; email_verified?: number }
      | undefined;
    if (!user?.id) {
      sendError(res, 'User not found', 401);
      return;
    }
    if (Number(user.status ?? 1) === 0) {
      sendError(res, 'Account is disabled', 403);
      return;
    }

    const isTotpEnabled = (await getTOTPStatus(uid)).enabled;
    const isWebauthnEnabled = await TwoFAOperations.isWebAuthnEnabled(uid);
    // 与 /login、OAuth 回调同口径：开关 && 有邮箱 && 已验证（否则是一个点不出码的死选项）
    const isEmailFactorEnabled = (await TwoFAOperations.isEmailEnabled(uid))
      && Boolean(user.email)
      && Boolean((user as { email_verified?: number }).email_verified);

    if (emailCode && isEmailFactorEnabled) {
      const validEmailCode = await verifyEmailVerificationCode(uid, String(user.email ?? ''), emailCode, 'login');
      if (!validEmailCode) {
        sendError(res, 'Invalid email verification code', 401);
        return;
      }
    } else if (backupCode) {
      if (!(await verifyBackupCode(uid, backupCode))) {
        sendError(res, 'Invalid backup code', 401);
        return;
      }
    } else if (totpCode && isTotpEnabled) {
      const secret = await TwoFAOperations.getTOTPSecret(uid);
      if (!secret || !verifyTOTPToken(secret, totpCode)) {
        sendError(res, 'Invalid 2FA code', 401);
        return;
      }
    } else if (webauthnResponse && isWebauthnEnabled) {
      const expectedChallenge = (global as any).loginChallengeStore?.get(uid);
      if (!expectedChallenge) {
        sendError(res, 'WebAuthn challenge expired or missing', 400);
        return;
      }
      const creds = await getUserWebAuthnCredentials(uid);
      const assertion = webauthnResponse as { id?: string };
      const cred = creds.find((c: any) => c.id === assertion.id);
      if (!cred) {
        sendError(res, 'Credential not found', 404);
        return;
      }
      const webAuthn = resolveWebAuthnConfig(req);
      const verification = await verifyAuthenticationResponse({
        response: webauthnResponse as never,
        expectedChallenge,
        expectedOrigin: webAuthn.origin,
        expectedRPID: webAuthn.rpID,
        requireUserVerification: process.env.WEBAUTHN_REQUIRE_UV !== '0',
        // 同 /login 的 webauthn 分支：v13 用 credential/publicKey
        credential: {
          id: cred.id,
          publicKey: Buffer.from(cred.public_key, 'base64'),
          counter: cred.counter,
          transports: cred.transports as unknown as AuthenticatorTransportFuture[],
        },
      });
      if (!verification.verified) {
        sendError(res, 'WebAuthn verification failed', 401);
        return;
      }
      await updateWebAuthnCredentialCounter(cred.id, verification.authenticationInfo.newCounter);
      (global as any).loginChallengeStore.delete(uid);
    } else {
      sendError(res, '2FA code is required', 400);
      return;
    }

    // 与密码登录一致：邮箱未验证的非超管用户先补验证（2FA 已完成，pendingToken 标记已过 2FA）
    if (await shouldRequireEmailVerification(user as { email?: string; email_verified?: number; role_level?: number })) {
      // 用 -4 而不是 code 0：避免前端把「登录未完成」当成成功
      await logAuditOperation(uid, 'oauth_login_pending_email', 'system', { twoFactor: true });
      res.json({
        code: -4,
        msg: 'Email verification required',
        data: {
          requireEmailVerification: true,
          email: user.email,
          pendingToken: await signEmailVerifyPendingToken(uid, true),
        },
      });
      return;
    }

    const token = await signToken({
      userId: uid,
      username: String(user.username ?? ''),
      nickname: String(user.nickname ?? ''),
      role: (Number(user.role_level ?? 1) || 1) as 1 | 2 | 3,
    });
    setAuthCookie(res, token);
    await logAuditOperation(uid, 'oauth_login', 'system', { twoFactor: true });
    sendSuccess(res, {
      user: { id: uid, username: user.username, nickname: user.nickname, role: user.role },
    });
  } catch (error) {
    log.error('OAuth 2FA failed', { error: error instanceof Error ? error.message : String(error) });
    // 断言校验失败与真正的服务端异常要分开：前者是可重试的业务失败，不该报 500。
    const message = error instanceof Error ? error.message : '';
    const isWebAuthn = /webauthn|credential|assertion|challenge|verification/i.test(message);
    sendError(
      res,
      isWebAuthn ? '通行密钥验证失败，请重试' : '验证失败，请重试',
      isWebAuthn ? 401 : 500,
      { kind: isWebAuthn ? 'webauthn' : 'internal' },
    );
  }
});

/**
 * 通行密钥免密登录。
 *
 * 与 /login 的 webauthn 分支的区别：**不需要密码**。
 * 产品口径（2026-11-27）：通行密钥既可作为登录凭证，也可作为二步凭证；
 * 用它完成登录后**不再要求额外验证**——它本身就是强认证。
 *
 * 安全前提：UV 默认强制（WEBAUTHN_REQUIRE_UV 未设置时按开启处理），
 * 否则「持有设备」就等于完整登录。
 */
router.post('/webauthn/login', loginLimiter, async (req: Request, res: Response) => {
  try {
    const { username, webauthnResponse } = req.body as { username?: string; webauthnResponse?: { id?: string } };
    if (!username || !webauthnResponse?.id) {
      sendError(res, 'username and webauthnResponse are required', 400);
      return;
    }

    const user = await UserOperations.getByUsername(String(username).trim()) as
      | { id?: number; username?: string; nickname?: string; role?: string; role_level?: number; status?: number; email?: string; email_verified?: number }
      | undefined;
    // 防枚举：无论账号是否存在、是否启用通行密钥、凭据是否匹配，对外都是同一句
    const reject = () => sendError(res, '通行密钥验证失败，请重试或改用密码登录', 401, { kind: 'webauthn' });
    if (!user?.id || Number(user.status ?? 1) === 0) { reject(); return; }

    const enabled = await TwoFAOperations.isWebAuthnEnabled(Number(user.id));
    if (!enabled) { reject(); return; }

    const creds = await getUserWebAuthnCredentials(Number(user.id));
    const cred = creds.find((c) => c.id === webauthnResponse.id);
    if (!cred) { reject(); return; }

    const expectedChallenge = (global as any).loginChallengeStore?.get(Number(user.id));
    if (!expectedChallenge) {
      sendError(res, '验证已过期，请重新发起登录', 400, { kind: 'webauthn' });
      return;
    }

    const webAuthn = resolveWebAuthnConfig(req);
    const verification = await verifyAuthenticationResponse({
      response: webauthnResponse as never,
      expectedChallenge,
      expectedOrigin: webAuthn.origin,
      expectedRPID: webAuthn.rpID,
      requireUserVerification: process.env.WEBAUTHN_REQUIRE_UV !== '0',
      credential: {
        id: cred.id,
        publicKey: Buffer.from(cred.public_key, 'base64'),
        counter: cred.counter,
        transports: cred.transports as unknown as AuthenticatorTransportFuture[],
      },
    });

    if (!verification.verified) { reject(); return; }

    await updateWebAuthnCredentialCounter(cred.id, verification.authenticationInfo.newCounter);
    (global as any).loginChallengeStore.delete(Number(user.id));

    // 邮箱验证策略仍然生效：通行密钥解决「你是谁 + 强认证」，不解决「邮箱是否可信」
    if (await shouldRequireEmailVerification(user as { email?: string; email_verified?: number; role_level?: number })) {
      res.json({
        code: -4,
        msg: 'Email verification required',
        data: {
          requireEmailVerification: true,
          email: user.email,
          pendingToken: await signEmailVerifyPendingToken(Number(user.id), true),
        },
      });
      return;
    }

    const token = await signToken({
      userId: Number(user.id),
      username: String(user.username ?? ''),
      nickname: String(user.nickname ?? ''),
      role: (Number(user.role_level ?? 1) || 1) as 1 | 2 | 3,
    });
    setAuthCookie(res, token);
    await logAuditOperation(Number(user.id), 'login', 'system', {
      factor: 'webauthn',
      // 审计记录本次是否做了用户验证：免密登录场景下 UV 是唯一能挡住「静默断言」的位
      uv: verification.authenticationInfo.userVerified,
    });
    sendSuccess(res, {
      user: { id: Number(user.id), username: user.username, nickname: user.nickname, email: user.email, role: user.role },
    });
  } catch (error) {
    log.error('Passkey login failed', { error: error instanceof Error ? error.message : String(error) });
    sendError(res, '通行密钥验证失败，请重试或改用密码登录', 401, { kind: 'webauthn' });
  }
});
router.post('/verify-email/code', emailLimiter, async (req: Request, res: Response) => {
  try {
    const { pendingToken } = req.body as { pendingToken?: string };
    const pending = pendingToken ? await verifyEmailVerifyPendingToken(pendingToken) : null;
    const userId = pending?.userId ?? null;
    if (userId) {
      const user = await UserOperations.getById(userId) as { id?: number; email?: string; email_verified?: number; role_level?: number; status?: number } | undefined;
      // 10 分钟窗口内账号可能被停用 / 策略被关闭：与登录侧同口径复查，不满足就静默不发
      const stillNeeded = user ? await shouldRequireEmailVerification(user) : false;
      if (user?.id && user.email && Number(user.status ?? 1) !== 0 && stillNeeded) {
        try {
          await sendEmailVerificationCode(Number(user.id), String(user.email), 'profile');
        } catch (error) {
          log.warn('Failed to send verification email code', { error });
        }
      }
    }
    sendSuccess(res, { sent: true }, '如果该账号有邮箱，验证码会发送过去');
  } catch (error) {
    sendError(res, error instanceof Error ? error.message : 'Failed to send code', 500);
  }
});
router.post('/verify-email', emailVerifyLimiter, async (req: Request, res: Response) => {
  const { pendingToken, code } = req.body as { pendingToken?: string; code?: string };
  if (!pendingToken || !code) {
    sendError(res, 'pendingToken and code are required', 400);
    return;
  }
  const pending = await verifyEmailVerifyPendingToken(pendingToken);
  const user = pending
    ? (await UserOperations.getById(pending.userId) as { id?: number; email?: string } | undefined)
    : undefined;
  // 与「验证码错误」保持同一响应，避免用户名枚举
  if (!user?.id || !user.email) {
    sendError(res, 'Invalid email verification code', 401);
    return;
  }
  const ok = await verifyEmailVerificationCode(Number(user.id), String(user.email), String(code), 'profile');
  if (!ok) {
    sendError(res, 'Invalid email verification code', 401);
    return;
  }
  // 必须在置位前判断（user 是验证前的快照）：置位后 shouldRequireEmailVerification 恒为 false
  const shouldIssue = await shouldRequireEmailVerification(user as { email?: string; email_verified?: number; role_level?: number });
  await UserOperations.update(Number(user.id), { email_verified: 1 });
  await logAuditOperation(Number(user.id), 'verify_email', 'system', {}, req);

  // 只有「本来就在 -4 状态」的账号才签发会话：
  // 否则已验证用户 / 策略关闭时也能用邮箱码换会话，等于多出一条常开的免密登录通道。
  if (!shouldIssue) {
    sendSuccess(res, { verified: true });
    return;
  }

  const uid = Number(user.id);
  const fullUser = await UserOperations.getById(uid) as
    | { id?: number; username?: string; nickname?: string; role?: string; role_level?: number; status?: number }
    | undefined;

  // 与 /login 同口径：停用账号不允许拿到会话
  if (Number(fullUser?.status ?? 1) === 0) {
    sendError(res, 'Account is disabled', 403);
    return;
  }

  // 已经在本轮登录里通过过第二因子（密码登录的 -4 在 2FA 之后），就不再要求第二次；
  // OAuth 走到 -4 说明本次策略不要求 2FA（否则上面已 -2/-3 返回），因此同样标 true。
  const alreadyPassed2FA = pending?.twoFAVerified === true;

  const totpStatus = await getTOTPStatus(uid);
  const isTotpEnabled = totpStatus.enabled;
  const isWebauthnEnabled = await TwoFAOperations.isWebAuthnEnabled(uid);
  const isEmailFactorEnabled = await TwoFAOperations.isEmailEnabled(uid);
  const has2FA = isTotpEnabled || isWebauthnEnabled || isEmailFactorEnabled;

  // 强制 2FA 但用户没配：与 /login 的 -3 一致，不能因为「验证邮箱」就放行
  // 注意：这里不能加 !alreadyPassed2FA —— 该条件只会命中「完全没有 2FA」的用户，
  // 而这种用户不可能在密码登录里通过 2FA 走到 -4；短路会让 OAuth 路径绕过全局强制 2FA。
  if (!alreadyPassed2FA && has2FA) {
    const types: string[] = [];
    if (isTotpEnabled) types.push('totp');
    if (isWebauthnEnabled) types.push('webauthn');
    if (isEmailFactorEnabled) types.push('email');
    sendSuccess(res, { verified: true, require2FA: true, types });
    return;
  }

  const token = await signToken({
    userId: uid,
    username: String(fullUser?.username ?? ''),
    nickname: String(fullUser?.nickname ?? ''),
    role: (Number(fullUser?.role_level ?? 1) || 1) as 1 | 2 | 3,
  });
  setAuthCookie(res, token);
  sendSuccess(res, {
    verified: true,
    user: {
      id: uid,
      username: fullUser?.username,
      nickname: fullUser?.nickname,
      email: user.email,
      role: fullUser?.role,
    },
  });
});
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
    sendInternalError(res, error, 'Failed to start oauth flow', 400);
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
    sendInternalError(res, error, 'Failed to start oauth bind flow', 400);
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

    // OAuth 只服从自己的开关（默认关闭）：全局强制 2FA 开启但 OAuth 开关关闭时，OAuth 不做 2FA。
    // 未配置 2FA 的账号同样跳过（与 /login 同口径）。
    const oauthNeed2FA = await shouldRequireOAuth2FA();
    if (oauthNeed2FA && (await has2FAEnabled(Number(user.id)))) {
      addProcessedCode(code);
      const oauthUid = Number(user.id);
      const oauthTotp = (await getTOTPStatus(oauthUid)).enabled;
      const oauthWebauthn = await TwoFAOperations.isWebAuthnEnabled(oauthUid);
      // 与 /login 同口径：开关 && 有邮箱 && 已验证，否则不展示这个走不通的选项
      const oauthEmailFactor = (await TwoFAOperations.isEmailEnabled(oauthUid))
        && Boolean(user.email)
        && Boolean((user as { email_verified?: number }).email_verified);
      const oauthTypes: string[] = [];
      if (oauthTotp) oauthTypes.push('totp');
      if (oauthWebauthn) oauthTypes.push('webauthn');
      if (oauthEmailFactor) oauthTypes.push('email');
      res.json({
        code: -2,
        msg: '2FA required',
        data: {
          require2FA: true,
          types: oauthTypes,
          email: user.email,
          username: user.username,
          // OAuth 用户没有密码，用一次性凭证替代密码去完成第二因子
          pendingToken: await signOAuth2FAPendingToken(Number(user.id)),
        },
      });
      return;
    }

    // 与密码登录同一口径：未验证邮箱的非超管用户先补验证，避免 OAuth 成为绕过通道
    if (await shouldRequireEmailVerification(user as { email?: string; email_verified?: number; role_level?: number })) {
      addProcessedCode(code);
      res.json({
        code: -4,
        msg: 'Email verification required',
        data: {
          requireEmailVerification: true,
          email: user.email,
          // 走到这里说明本次 OAuth 不需要 2FA（开关关闭或用户未配），验证邮箱后可直接签发
          pendingToken: await signEmailVerifyPendingToken(Number(user.id), true),
        },
      });
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
    sendInternalError(res, error, 'OAuth callback failed', 500);
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
    sendInternalError(res, error, 'Failed to get oauth bindings', 500);
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
    sendInternalError(res, error, 'Failed to unbind oauth account', 500);
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
    sendInternalError(res, error, 'Failed to get user info', 500);
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
    sendInternalError(res, error, 'Failed to change password', 500);
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
      // 超长邮箱直接报错，不截断——截断会让两个不同邮箱在库里变成同一个。
      // 上限与 MySQL 唯一约束的生成列宽度一致（见 utils/validation.ts）。
      if (nextEmail && !isValidEmail(nextEmail)) {
        res.status(400).json({
          code: 400,
          msg: `邮箱格式不正确，或超过 ${EMAIL_MAX_LENGTH} 个字符`,
          data: { field: 'email' },
        });
        return;
      }
      if (nextEmail !== user.email) {
        if (!emailCode || !(await verifyEmailVerificationCode(user.id as number, nextEmail, emailCode))) {
          res.status(400).json({ code: 400, msg: 'Valid email verification code is required' });
          return;
        }
        // 只有「邮箱确实变了且验证码通过」才把新邮箱标记为已验证。
        // 放在分支外会让「只改昵称」（客户端恒定提交 email）把未验证邮箱静默置 1。
        updates.email_verified = nextEmail ? 1 : 0;
        // 邮箱唯一：唯一索引是最后一道防线，这里先给出可读错误（issue #43 C0）
        if (nextEmail) {
          const occupied = await UserOperations.getByEmail(nextEmail);
          const occupiedId = Number((occupied as { id?: number } | undefined)?.id ?? 0);
          if (occupiedId && occupiedId !== Number(user.id)) {
            res.status(409).json({ code: 409, msg: '该邮箱已被其它账号使用' });
            return;
          }
        }
      }
      updates.email = nextEmail || null;
    }

    await UserOperations.update(user.id as number, updates);
    const updatedResult = await UserOperations.getPublicById(user.id as number);
    if (email !== undefined && email.trim() !== user.email) {
      await logAuditOperation(user.id as number, 'update_profile_email', 'system', { oldEmail: user.email, newEmail: email.trim() });
    }
    res.json({ code: 0, data: updatedResult, msg: 'success' });
  } catch (error) {
    sendInternalError(res, error, 'Failed to update profile', 500);
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
    sendInternalError(res, error, 'Failed to send verification code', 500);
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
    sendInternalError(res, error, 'Failed to send password reset code', 500);
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
    sendInternalError(res, error, 'Failed to reset password', 500);
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
        backgroundOpacity: preferences.backgroundOpacity ?? 100,
      },
      msg: 'success',
    });
  } catch (error) {
    sendInternalError(res, error, 'Failed to get preferences', 500);
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
  const { theme, language, notificationsEnabled, emailNotifications, backgroundImage, avatarImage, backgroundOpacity } = req.body as Partial<UserPreferences>;

  try {
    const updates: Partial<UserPreferences> = {};
    if (theme !== undefined) updates.theme = theme;
    if (language !== undefined) updates.language = language;
    if (notificationsEnabled !== undefined) updates.notificationsEnabled = notificationsEnabled;
    if (emailNotifications !== undefined) updates.emailNotifications = emailNotifications;
    if (backgroundImage !== undefined) updates.backgroundImage = backgroundImage;
    if (avatarImage !== undefined) updates.avatarImage = avatarImage;
    if (backgroundOpacity !== undefined) {
      // 服务端校验：这个值直接写进 CSS 变量，不能让任意数字/字符串进入样式层
      const opacity = Number(backgroundOpacity);
      if (!Number.isFinite(opacity)) {
        res.status(400).json({ code: 400, msg: 'backgroundOpacity must be a number between 0 and 100' });
        return;
      }
      updates.backgroundOpacity = Math.min(100, Math.max(0, Math.round(opacity)));
    }

    await updateUserPreferences(req.user!.userId, updates);
    await logAuditOperation(req.user!.userId, 'update_preferences', 'system', updates);
    res.json({ code: 0, msg: 'success' });
  } catch (error) {
    sendInternalError(res, error, 'Failed to update preferences', 500);
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
    sendInternalError(res, error, 'Failed to get pinned domains', 500);
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
    sendInternalError(res, error, 'Failed to update pinned domains', 500);
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
