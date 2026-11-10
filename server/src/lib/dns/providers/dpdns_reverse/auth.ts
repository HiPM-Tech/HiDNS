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
import { createProviderAuthLogger, fetchWithFallback } from '../internal';
import {
  buildAssertion,
  parsePasskeyCredential,
  DEFAULT_DPDNS_ORIGIN,
} from './passkey';

const log = createProviderAuthLogger('DPDNS');

export const DPDNS_BASE_URL = 'https://dashboard.digitalplat.org';
const PANEL_API = `${DPDNS_BASE_URL}/_panel_api`;
const CSRF_HEADER = 'X-CSRF-Token';

/** WebAuthn signCount 是 32 位无符号数（4 字节大端） */
export const MAX_SIGN_COUNTER = 0xffffffff;
/** 软阈值：超过只打日志，仍然继续递增 */
export const WARN_SIGN_COUNTER = 300;

/**
 * 下一次断言使用的 signCount。
 *
 * 对齐标准校验库（@simplewebauthn/server）的语义：
 *   if (stored > 0 || next > 0) require(next > stored)
 * 因此：
 * - **首次发 1**：stored=0 且 next=1 时严格实现（要求 next > 0）与 SimpleWebAuthn（next > stored）都通过；
 *   发 0 会被「无条件要求 new > stored」的实现拒绝，而这类严格实现并不少见；
 * - 之后必须**严格 +1**，不能回绕——回绕会被判成「计数器倒退 / 疑似克隆」；
 * - 只有到 32 位上限（4294967295）才回到 1，此时应当重新注册凭据。
 */
export function nextSignCounter(current?: number): number {
  if (current === undefined || current === null) return 1;
  const value = Math.trunc(Number(current));
  if (!Number.isFinite(value) || value < 0) return 1;
  if (value >= MAX_SIGN_COUNTER) return 1;
  return value + 1;
}

export interface DpdnsSessionState {
  /** 完整 Cookie 串（remember_token / panel_session / panel_device / panel_csrf_token） */
  sessionCookie: string;
  /** 会话主凭证（从 Cookie 里抽出来单存，便于兼容历史字段与快速校验） */
  rememberToken: string | null;
  /** 本次断言使用的 signCount，调用方需要持久化，下次继续递增 */
  signCounter: number;
  /** 本次计数对应的凭据 ID，调用方需要持久化，用于识别「换了凭据」 */
  signCounterFor: string;
}

export interface DpdnsAuthConfig {
  /** Bitwarden 导出的通行密钥条目（JSON 字符串或对象） */
  passkey?: unknown;
  /** 完整 Cookie 串（含 remember_token / panel_session / panel_device），由换签写入 */
  sessionCookie?: string;
  /** 会话主凭证：隐藏字段，换签后由服务端写入，旧账号里可能是用户当年手抄的值 */
  rememberToken?: string;
  /** WebAuthn signCount 游标：隐藏字段，每次换签 +1（不回绕） */
  signCounter?: number;
  /** 该游标对应的凭据 ID：换凭据（或新建账号）后计数必须从 1 重新开始 */
  signCounterFor?: string;
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

/**
 * Set-Cookie → name→value。
 *
 * fetch 会把多条 Set-Cookie 合并成一个字符串，且**逗号后不一定有空格**（`a=1,b=2`）。
 * 之前按 `, `（逗号+空格）切分，遇到无空格合并时只解析出第一条，
 * 于是 panel_csrf_token 被丢掉、begin 永远 400 csrf_failed。
 * 这里改成「逗号 + 可选的空白 + name=」作为边界；`Expires=Wed, 21 Oct …` 里的
 * 逗号后面是 `21 Oct`，不匹配 name=，不会被误切。
 */
function parseSetCookieHeader(raw: string): Map<string, string> {
  const cookies = new Map<string, string>();
  const segments = raw.split(/,(?=\s*[A-Za-z0-9._-]+=)/);
  for (const seg of segments) {
    const m = seg.match(/^\s*([A-Za-z0-9._-]+)=([^;]*)/);
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

/**
 * 读取响应里的全部 Set-Cookie。
 *
 * 优先用 getSetCookie()（undici 提供，返回数组）：走代理时多个 Set-Cookie 会被合并成
 * 一个逗号串，手工切分容易被 cookie 值里的逗号/Expires 日期切错，导致读不到 remember_token。
 */
function extractSetCookies(res: Response): Array<[string, string]> {
  const headers = res.headers as unknown as {
    getSetCookie?: () => string[];
    get(name: string): string | null;
  };
  const list = headers.getSetCookie?.();
  const rawList = list && list.length > 0 ? list : [headers.get('set-cookie') ?? ''].filter(Boolean);
  const pairs: Array<[string, string]> = [];
  for (const raw of rawList) {
    for (const [key, value] of parseSetCookieHeader(raw)) pairs.push([key, value]);
  }
  return pairs;
}

function absorbCookies(config: DpdnsAuthConfig, res: Response): void {
  const pairs = extractSetCookies(res);
  if (pairs.length === 0) return;
  const map = resolveSessionJar(config);
  for (const [k, v] of pairs) map.set(k, v);
  config.sessionCookie = buildCookieJar(map);
  const token = map.get('remember_token');
  if (token) config.rememberToken = token;
  const csrf = map.get('panel_csrf_token');
  if (csrf) config.csrfToken = decodeURIComponent(csrf);
}

function cookieHeader(config: DpdnsAuthConfig): string {
  return buildCookieJar(resolveSessionJar(config)) ?? '';
}

/** CSRF 阶段的诊断信息：begin 失败时附在错误里，直接看出是代理丢头还是没拿到 token */
const csrfDiag = new WeakMap<object, { cookieNames: string[]; hadCookieToken: boolean; direct: boolean }>();

/** 底层请求：自动带 Cookie 与 CSRF 头，并吸收响应里的 Set-Cookie */
async function send(
  url: string,
  config: DpdnsAuthConfig,
  options: RequestInit = {},
  extra: { direct?: boolean } = {},
): Promise<Response> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = buildBrowserHeaders({
    ...(options.headers as Record<string, string | undefined>),
    Cookie: cookieHeader(config),
  });
  if (config.csrfToken && method !== 'GET' && method !== 'HEAD') {
    headers[CSRF_HEADER] = config.csrfToken;
  }
  const res = await fetchWithFallback(
    url,
    { ...options, headers },
    extra.direct ? false : (config.useProxy ?? false),
    'DPDNS',
  );
  absorbCookies(config, res);
  return res;
}

/**
 * 取 CSRF token（同时建立 panel_csrf_token cookie）。
 *
 * 判定顺序很重要：**以服务端下发的 cookie 为准**，而不是 body。
 * 服务端校验的是「header 里的 token 与它自己记在会话/cookie 里的值」，
 * 用 body 覆盖 cookie 会造出「两边都变了、但都不是服务端认的那个」的假一致。
 * 只有在完全没有 cookie 时才用 body 值补一份。
 *
 * 另一个坑：走代理时响应头可能丢 Set-Cookie，导致永远拿不到 panel_csrf_token。
 * 这种情况会直连再取一次。
 */
export async function ensureCsrfToken(config: DpdnsAuthConfig): Promise<string | undefined> {
  let direct = false;
  let res = await send(`${PANEL_API}/api/security/csrf`, config);
  let pairs = extractSetCookies(res);

  if (pairs.length === 0 && config.useProxy) {
    log.sub('Auth').tag('CSRF').warn('CSRF 响应没有 Set-Cookie，改为直连重试', {});
    res = await send(`${PANEL_API}/api/security/csrf`, config, {}, { direct: true });
    pairs = extractSetCookies(res);
    direct = true;
  }

  if (!res.ok) {
    log.sub('Auth').tag('CSRF').warn('获取 CSRF token 失败，沿用旧 token', { status: res.status });
    return config.csrfToken;
  }
  const body = await res.json().catch(() => null) as { csrf_token?: string } | null;

  const jar = resolveSessionJar(config);
  const cookieToken = jar.get('panel_csrf_token');
  // body 里的 token 才是「这次请求签发的那一份」；有会话时服务端可能只回 body、不重发 cookie，
  // 此时若沿用旧 cookie 就会和服务端会话里的值对不上（renew 报 Invalid CSRF token）。
  // 所以以 body 为准，并把它同步进 cookie，保证 header 与 cookie 始终同值。
  const token = body?.csrf_token ?? cookieToken;

  csrfDiag.set(config, {
    cookieNames: pairs.map(([name]) => name),
    hadCookieToken: Boolean(cookieToken),
    direct,
  });

  if (!token) return config.csrfToken;

  config.csrfToken = token;
  if (cookieToken !== token) {
    jar.set('panel_csrf_token', token);
    config.sessionCookie = buildCookieJar(jar);
  }
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

  // 换签从干净会话开始：旧的 remember_token/panel_session 会撞 CSRF，旧的 panel_csrf_token 也可能已失效。
  // 清空后由 ensureCsrfToken 重新取一份，并按「服务端下发的 cookie 优先」建立 header/cookie 一致状态。
  config.rememberToken = undefined;
  config.sessionCookie = undefined;
  config.csrfToken = undefined;
  verifiedAt.delete(config);

  const csrf = await ensureCsrfToken(config);
  if (!csrf) throw new Error('通行密钥换签失败[csrf]：未能获取 CSRF token');

  const startBegin = () => send(`${PANEL_API}/api/auth/passkey/begin`, config, {
    method: 'POST',
    body: JSON.stringify({ purpose: 'login' }),
  });

  let begin = await startBegin();
  let { json: beginBody, raw: beginRaw } = await readJson(begin);

  // CSRF 过期/不一致时刷新一次再重试：上游只回 body token、不下发 cookie 的部署也会命中
  if (begin.status === 400 && (beginBody as { code?: string } | null)?.code === 'csrf_failed') {
    await ensureCsrfToken(config);
    begin = await startBegin();
    ({ json: beginBody, raw: beginRaw } = await readJson(begin));
  }

  if (!begin.ok || !beginBody?.ok || !beginBody.options?.challenge || !beginBody.request_id) {
    // 带上响应摘要与 CSRF 阶段诊断：经过代理时可能拿到 HTML 错误页，或 Set-Cookie 被吞
    const diag = csrfDiag.get(config);
    const diagText = diag
      ? `；csrf 阶段${diag.direct ? '直连' : '代理'}，Set-Cookie: ${diag.cookieNames.join(',') || '无'}${diag.hadCookieToken ? '' : '（无 panel_csrf_token）'}`
      : '';
    throw new Error(`通行密钥换签失败[begin]：HTTP ${begin.status}，响应 ${summarize(beginRaw)}${diagText}`);
  }

  // 服务端可能严格校验 signCount 递增；Bitwarden 导出的 counter 恒为 0，必须自己推进。
  // 换了凭据（或新建账号）时必须从 1 重新开始：新凭据在上游记录的 counter 是 0，
  // 沿用旧游标虽然多数实现能过，但遇到「严格比较」的实现会被判为异常。
  const counterBase = config.signCounterFor && config.signCounterFor !== credential.credentialId
    ? undefined
    : config.signCounter;
  const signCounter = nextSignCounter(counterBase);
  if (signCounter > WARN_SIGN_COUNTER) {
    log.sub('Auth').tag('COUNTER').debug('signCount 超过软阈值，继续按标准库要求递增', { signCounter });
  }

  let assertion;
  try {
    assertion = buildAssertion(credential, beginBody.options.challenge, DEFAULT_DPDNS_ORIGIN, signCounter);
  } catch (e: unknown) {
    throw new Error(`通行密钥换签失败[sign]：${e instanceof Error ? e.message : String(e)}`);
  }

  // redirect: 'manual' —— 上游可能用 302 下发 Set-Cookie；跟随重定向后最终响应就看不到这些头了
  const finish = await send(`${PANEL_API}/api/auth/passkey/finish`, config, {
    method: 'POST',
    body: JSON.stringify({ purpose: 'login', request_id: beginBody.request_id, credential: assertion }),
    redirect: 'manual',
  });
  const isRedirect = finish.status >= 300 && finish.status < 400;
  const { json: finishBody, raw: finishRaw } = await readJson(finish);
  if (!isRedirect && (!finish.ok || !finishBody?.ok)) {
    // 带上完整响应摘要：上游可能只给一句笼统的 “could not be verified”，
    // 但响应里往往还有 reason / code，能区分是签名、challenge 还是 counter 的问题。
    const detail = summarize(finishRaw, 300);
    throw new Error(
      `通行密钥换签失败[finish]：${finishBody?.error || `HTTP ${finish.status}`}${detail ? `（响应 ${detail}）` : ''}`,
    );
  }

  const jar = resolveSessionJar(config);
  const rememberToken = jar.get('remember_token') ?? null;
  if (!rememberToken) {
    const cookieNames = extractSetCookies(finish).map(([name]) => name).join(',') || '无';
    throw new Error(
      `通行密钥换签失败[finish]：HTTP ${finish.status} 已通过，但没有下发表会话 Cookie（Set-Cookie: ${cookieNames}；响应 ${summarize(finishRaw)}）`,
    );
  }

  config.sessionCookie = buildCookieJar(jar);
  config.rememberToken = rememberToken;
  config.signCounter = signCounter;
  config.signCounterFor = credential.credentialId;
  verifiedAt.set(config, Date.now());
  // 换签后用新会话再取一次 CSRF：finish 可能轮换了 token 但没有重发 cookie，
  // 这一份才是与服务端会话配对的
  await ensureCsrfToken(config);
  await config.onSession?.({
    sessionCookie: config.sessionCookie ?? '',
    rememberToken,
    signCounter,
    signCounterFor: credential.credentialId,
  });
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
      // 只刷新 token 常常不够：会话可能是「有效但 CSRF 绑定已丢」的状态，换签最彻底
      await loginWithPasskey(config);
      res = await send(url, config, options);
    }
  }
  return res;
}

/**
 * 校验账号是否可用（新建/编辑账号时调用）：能换签即视为有效。
 *
 * 注意：这里**不再**把异常吞成 false —— 否则调用方只能看到一句「凭据无效」，
 * 丢失了「卡在 csrf / begin / 签名 / finish 哪一步、上游返回了什么」这类关键信息。
 * 由 adapter.check() 捕获并写入 getError()。
 */
export async function validateCredentials(config: DpdnsAuthConfig): Promise<boolean> {
  await ensureSession(config);
  const res = await send(`${PANEL_API}/api/auth/me`, config);
  if (!res.ok) return false;
  const body = await res.json().catch(() => null) as { ok?: boolean; user?: unknown } | null;
  return body?.ok === true && !!body.user;
}
