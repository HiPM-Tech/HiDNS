/**
 * DigitalPlat（dpdns）会话管理。
 *
 * 认证方式经历了两次变化：
 *   旧：用户从 DevTools 手抄 remember_token（等价长期会话，易过期、要人盯）
 *   新：用 Bitwarden 导出的 **通行密钥（FIDO2）** 自动换签，换到的 Cookie 完整落进账号配置的
 *       隐藏字段 sessionCookie；有效期内直接复用，失效（401）时自动重新换签并重试一次。
 *
 * 上游（dashboard.digitalplat.org，Next.js 面板）的换签流程已实测：
 *   GET  /api/security/csrf                    → { csrf_token } + Set-Cookie
 *   POST /api/auth/passkey/begin  {purpose}    → { options, request_id }
 *   POST /api/auth/passkey/finish {purpose, request_id, credential}
 *                                              → { ok, user } + Set-Cookie(remember_token/panel_session/panel_device)
 *
 * 所有请求统一走 fetchWithFallback（代理环境下原生 fetch 会挂死，见 root.ai.md §DNS提供商适配器 1）。
 */
import { fetchWithFallback } from '../internal';
import {
  buildAssertion,
  parsePasskeyCredential,
  DEFAULT_DPDNS_ORIGIN,
} from './passkey';

export const DPDNS_BASE_URL = 'https://dashboard.digitalplat.org';
const PANEL_API = `${DPDNS_BASE_URL}/_panel_api`;
const CSRF_HEADER = 'X-CSRF-Token';

export interface DpdnsSessionState {
  /** 完整 Cookie 串（remember_token / panel_session / panel_device / panel_csrf_token） */
  sessionCookie: string;
  /** 会话主凭证（从 Cookie 里抽出来单存，便于兼容历史字段与快速校验） */
  rememberToken: string | null;
}

export interface DpdnsAuthConfig {
  /** Bitwarden 导出的通行密钥条目（JSON 字符串或对象） */
  passkey?: unknown;
  /** 完整 Cookie 串（含 remember_token / panel_session / panel_device），由换签写入 */
  sessionCookie?: string;
  /** 会话主凭证：隐藏字段，换签后由服务端写入，旧账号里可能是用户当年手抄的值 */
  rememberToken?: string;
  /**
   * 强制用通行密钥换签（忽略已有会话）。
   * 用户本次提交了新的通行密钥时必须为 true：否则旧 sessionCookie/rememberToken 会让 check 走
   * 「旧会话仍有效」的分支，新凭据根本没被验证过。
   */
  forcePasskey?: boolean;
  csrfToken?: string;
  useProxy?: boolean;
  /** 换签成功后回调，用于把新会话持久化到账号配置的隐藏字段 */
  onSession?: (session: DpdnsSessionState) => void | Promise<void>;
}

/**
 * 会话 Cookie 视图：以 sessionCookie 为主；缺失时用隐藏字段 rememberToken 兜底。
 * 这样旧账号（只有当年手抄的 remember_token）在过期前仍可用，过期后凭通行密钥重签。
 */
export function resolveSessionJar(config: Pick<DpdnsAuthConfig, 'sessionCookie' | 'rememberToken'>): Map<string, string> {
  const jar = parseCookieJar(config.sessionCookie);
  const token = jar.get('remember_token') || config.rememberToken;
  if (token) jar.set('remember_token', token);
  return jar;
}

/** 同一次会话校验的有效期（避免每个请求都打 /auth/me） */
const SESSION_TTL_MS = 60_000;
const verifiedAt = new WeakMap<object, number>();

function buildBrowserHeaders(headers?: Record<string, string>): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Origin': DPDNS_BASE_URL,
    'Referer': `${DPDNS_BASE_URL}/`,
    'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Cache-Control': 'no-cache',
    ...headers,
  };
}

/** Set-Cookie → name→value（fetch 会把多条合并成一个字符串，按「名字=」边界切） */
function parseSetCookieHeader(raw: string): Map<string, string> {
  const cookies = new Map<string, string>();
  const segments = raw.split(/, (?=[a-zA-Z][a-zA-Z0-9._-]*=)/);
  for (const seg of segments) {
    const m = seg.match(/^([^=]+)=([^;]*)/);
    if (m) cookies.set(m[1].trim(), m[2].trim());
  }
  return cookies;
}

export function parseCookieJar(jar: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!jar) return map;
  for (const part of jar.split('; ')) {
    const idx = part.indexOf('=');
    if (idx > 0) map.set(part.slice(0, idx), part.slice(idx + 1));
  }
  return map;
}

function buildCookieJar(map: Map<string, string>): string | undefined {
  if (map.size === 0) return undefined;
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function absorbCookies(config: DpdnsAuthConfig, res: Response): void {
  const raw = res.headers.get('set-cookie');
  if (!raw) return;
  const map = resolveSessionJar(config);
  for (const [k, v] of parseSetCookieHeader(raw)) map.set(k, v);
  config.sessionCookie = buildCookieJar(map);
  const token = map.get('remember_token');
  if (token) config.rememberToken = token;
  const csrf = map.get('panel_csrf_token');
  if (csrf) config.csrfToken = decodeURIComponent(csrf);
}

function cookieHeader(config: DpdnsAuthConfig): string {
  return buildCookieJar(resolveSessionJar(config)) ?? '';
}

/** 底层请求：自动带 Cookie 与 CSRF 头，并吸收响应里的 Set-Cookie */
async function send(
  url: string,
  config: DpdnsAuthConfig,
  options: RequestInit = {},
): Promise<Response> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = buildBrowserHeaders({
    ...(options.headers as Record<string, string> | undefined),
    Cookie: cookieHeader(config),
  });
  if (config.csrfToken && method !== 'GET' && method !== 'HEAD') {
    headers[CSRF_HEADER] = config.csrfToken;
  }
  const res = await fetchWithFallback(
    url,
    { ...options, headers },
    config.useProxy ?? false,
    'DPDNS',
  );
  absorbCookies(config, res);
  return res;
}

/** 取 CSRF token（同时建立 panel_csrf_token cookie） */
export async function ensureCsrfToken(config: DpdnsAuthConfig): Promise<string | undefined> {
  const res = await send(`${PANEL_API}/api/security/csrf`, config);
  if (!res.ok) return config.csrfToken;
  const body = await res.json().catch(() => null) as { csrf_token?: string } | null;
  if (body?.csrf_token) config.csrfToken = body.csrf_token;
  return config.csrfToken;
}


/** 读响应体：JSON 解析失败时保留原文，便于判断是不是代理返回的 HTML 错误页 */
async function readJson(res: Response): Promise<{ json: any; raw: string }> {
  const raw = await res.text().catch(() => '');
  if (!raw) return { json: null, raw: '' };
  try {
    return { json: JSON.parse(raw), raw };
  } catch {
    return { json: null, raw };
  }
}

/** 响应摘要：截断 + 压空白，避免日志/界面被整页 HTML 淹没 */
function summarize(raw: string, max = 160): string {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '(空)';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 用通行密钥换签：csrf → passkey/begin → 本地签名 → passkey/finish。
 * 成功后 config.sessionCookie 为完整 Cookie 串，并触发 onSession 持久化。
 */
export async function loginWithPasskey(config: DpdnsAuthConfig): Promise<void> {
  const credential = parsePasskeyCredential(config.passkey);
  if (!credential) {
    // 只报“收到了多少”，不打印凭据内容
    const raw: unknown = config.passkey;
    const text = typeof raw === 'string' ? raw.trim() : '';
    const shape = typeof raw !== 'string'
      ? (raw == null ? '未填写' : `收到 ${typeof raw}`)
      : (text ? `收到 ${text.length} 字符` : '字段为空');
    throw new Error(`通行密钥配置无效（${shape}）：请粘贴 JSON，单条凭据对象或含 fido2Credentials 数组的对象都可以`);
  }

  // 换签必须从干净会话开始，否则会带着过期 cookie / remember_token 撞 CSRF
  config.sessionCookie = undefined;
  config.rememberToken = undefined;
  config.csrfToken = undefined;
  verifiedAt.delete(config);

  const csrf = await ensureCsrfToken(config);
  if (!csrf) throw new Error('通行密钥换签失败[csrf]：未能获取 CSRF token');

  const begin = await send(`${PANEL_API}/api/auth/passkey/begin`, config, {
    method: 'POST',
    body: JSON.stringify({ purpose: 'login' }),
  });
  const { json: beginBody, raw: beginRaw } = await readJson(begin);
  if (!begin.ok || !beginBody?.ok || !beginBody.options?.challenge || !beginBody.request_id) {
    // 带上响应摘要：经过代理时可能拿到 HTML 错误页而不是 JSON，光看状态码分不出来
    throw new Error(`通行密钥换签失败[begin]：HTTP ${begin.status}，响应 ${summarize(beginRaw)}`);
  }

  let assertion;
  try {
    assertion = buildAssertion(credential, beginBody.options.challenge, DEFAULT_DPDNS_ORIGIN);
  } catch (e: unknown) {
    throw new Error(`通行密钥换签失败[sign]：${e instanceof Error ? e.message : String(e)}`);
  }

  const finish = await send(`${PANEL_API}/api/auth/passkey/finish`, config, {
    method: 'POST',
    body: JSON.stringify({ purpose: 'login', request_id: beginBody.request_id, credential: assertion }),
  });
  const { json: finishBody, raw: finishRaw } = await readJson(finish);
  if (!finish.ok || !finishBody?.ok) {
    throw new Error(`通行密钥换签失败[finish]：${finishBody?.error || `HTTP ${finish.status}，响应 ${summarize(finishRaw)}`}`);
  }
  const jar = resolveSessionJar(config);
  const rememberToken = jar.get('remember_token') ?? null;
  if (!rememberToken) {
    throw new Error('通行密钥换签成功但未拿到会话 Cookie');
  }

  config.sessionCookie = buildCookieJar(jar);
  config.rememberToken = rememberToken;
  verifiedAt.set(config, Date.now());
  await config.onSession?.({ sessionCookie: config.sessionCookie ?? '', rememberToken });
}

/** 会话是否可用；不可用则换签。60s 内复用校验结果，避免每个请求都打 /auth/me */
export async function ensureSession(config: DpdnsAuthConfig): Promise<void> {
  // 本次提交了新的通行密钥：必须用它真实验证一次，不能拿旧会话蒙混过关
  if (config.forcePasskey) {
    await loginWithPasskey(config);
    return;
  }

  const last = verifiedAt.get(config);
  if (last && Date.now() - last < SESSION_TTL_MS && resolveSessionJar(config).get('remember_token')) {
    return;
  }

  // 有会话凭证就验证（可能是 sessionCookie，也可能是隐藏字段 rememberToken 兜底）
  if (resolveSessionJar(config).get('remember_token')) {
    const res = await send(`${PANEL_API}/api/auth/me`, config);
    if (res.ok) {
      const body = await res.json().catch(() => null) as { ok?: boolean; user?: unknown } | null;
      if (body?.ok && body.user) {
        const jar = resolveSessionJar(config);
        config.sessionCookie = buildCookieJar(jar);
        config.rememberToken = jar.get('remember_token') ?? config.rememberToken;
        verifiedAt.set(config, Date.now());
        return;
      }
    }
  }
  await loginWithPasskey(config);
}

/**
 * 带会话的请求：Cookie 优先；401 视作会话失效，换签后重试一次。
 * 403 + csrf_failed 视作 CSRF 过期，刷新 token 后重试一次。
 */
export async function authenticatedRequest(
  url: string,
  config: DpdnsAuthConfig,
  options: RequestInit = {},
): Promise<Response> {
  await ensureSession(config);

  let res = await send(url, config, options);
  if (res.status === 401) {
    await loginWithPasskey(config);
    res = await send(url, config, options);
    return res;
  }
  if (res.status === 403) {
    const probe = await res.clone().json().catch(() => null) as { code?: string } | null;
    if (probe?.code === 'csrf_failed') {
      await ensureCsrfToken(config);
      res = await send(url, config, options);
    }
  }
  return res;
}

/** 校验账号是否可用（新建/编辑账号时调用）：能换签即视为有效 */
export async function validateCredentials(config: DpdnsAuthConfig): Promise<boolean> {
  try {
    await ensureSession(config);
    const res = await send(`${PANEL_API}/api/auth/me`, config);
    if (!res.ok) return false;
    const body = await res.json().catch(() => null) as { ok?: boolean; user?: unknown } | null;
    return body?.ok === true && !!body.user;
  } catch {
    return false;
  }
}
