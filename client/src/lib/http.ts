/**
 * 类型化 HTTP 客户端（新前端唯一出口）。
 *
 * 约定（见 docs/refactor/00-PLAN.md）：
 * - 统一信封 { code, data, msg }，code === 0 表示成功；
 * - 仅传输层/HTTP 错误抛 ApiError；业务码由调用方判断（登录需要区分 -2 = 需要 2FA）；
 * - 一律 credentials: 'include'（JWT 存 httpOnly Cookie）；
 * - 401 统一跳登录页（登录接口本身除外）。
 */

export interface ApiEnvelope<T> {
  code: number;
  data: T;
  msg: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: number;
  readonly data: unknown;

  constructor(message: string, options: { status: number; code?: number; data?: unknown }) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.code = options.code ?? options.status;
    this.data = options.data;
  }
}

export function apiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_URL as string | undefined;
  if (configured) return configured.replace(/\/$/, '');
  return `${window.location.protocol}//${window.location.host}/api`;
}

const LOGIN_PATH = '/login';
const PUBLIC_PATHS = ['/login', '/', '/setup'];
/**
 * 401 不触发整页跳转的端点：
 * - 登录 / 公钥 / 重置密码：登录失败时本来就会 401，跳转会把用户从表单上踢走；
 * - `/auth/me` 与 `/auth/logout`：前者是会话探测，401 由路由守卫做 SPA 跳转（不整页刷新、能带
 *   return_to）；后者在会话已失效时必然 401，交给它自己的 finally 跳转。
 */
const AUTH_FREE_PATHS = ['/auth/login', '/auth/public-key', '/auth/password-reset', '/auth/me', '/auth/logout'];

function shouldRedirectOn401(path: string): boolean {
  if (AUTH_FREE_PATHS.some((p) => path.startsWith(p))) return false;
  const current = window.location.pathname;
  if (PUBLIC_PATHS.includes(current)) return false;
  if (current.startsWith('/oauth/')) return false;
  return true;
}

/**
 * 401 后要去的登录页地址：带上来源路径，登录完能回到原页面。
 * - 只接受站内路径（`//evil.com` 之类一律退回裸 `/login`）；
 * - 已经在登录页就不再叠加 return_to；
 * - 路径截断到 512 字符，避免异常长的 query 撑爆地址栏。
 */
export function loginRedirectUrl(pathname: string, search = ''): string {
  if (pathname === LOGIN_PATH || pathname.startsWith(`${LOGIN_PATH}/`)) return LOGIN_PATH;
  const target = `${pathname}${search}`;
  if (!target || target === '/' || target.startsWith('//')) return LOGIN_PATH;
  return `${LOGIN_PATH}?return_to=${encodeURIComponent(target.slice(0, 512))}`;
}

/**
 * 会话失效的统一出口：防并发重复导航（多个请求同时 401 时只跳一次），
 * 用 replace 而不是 href —— 回退键不该回到已经失效的页面。
 */
let redirectingToLogin = false;
function redirectToLogin(): void {
  if (redirectingToLogin) return;
  redirectingToLogin = true;
  window.location.replace(loginRedirectUrl(window.location.pathname, window.location.search));
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  /** JSON 请求体；传 undefined 表示无 body */
  body?: unknown;
  /** 查询参数（自动跳过 undefined/null） */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** 超时毫秒数；超时按网络错误抛 ApiError（用于检测类长耗时请求） */
  timeoutMs?: number;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<ApiEnvelope<T>> {
  const { body, query, headers, timeoutMs, ...rest } = options;
  const url = new URL(`${apiBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }

  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      ...(controller ? { signal: controller.signal } : {}),
      ...rest,
      credentials: 'include',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // 超时统一成 ApiError：调用方只需处理一种错误类型（文档与实现此前不一致，抛的是 AbortError）
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError('请求超时，请稍后重试', { status: 408, code: 408 });
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    if (timer) clearTimeout(timer);
  }

  let payload: unknown = undefined;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
  }

  if (response.status === 401 && shouldRedirectOn401(path)) {
    redirectToLogin();
  }

  if (!response.ok) {
    const envelope = payload as Partial<ApiEnvelope<unknown>> | undefined;
    throw new ApiError(envelope?.msg || `HTTP ${response.status}`, {
      status: response.status,
      code: envelope?.code,
      data: envelope?.data,
    });
  }

  const envelope = payload as ApiEnvelope<T> | undefined;
  if (!envelope || typeof envelope.code !== 'number') {
    throw new ApiError('Malformed API response', { status: response.status, data: payload });
  }
  return envelope;
}

/**
 * 写操作信封校验：`code !== 0` 直接抛错。
 * 写接口普遍不返回业务数据，调用方容易忘记判 code，导致「保存失败却提示成功」。
 */
export function ensureOk<T>(envelope: ApiEnvelope<T>): ApiEnvelope<T> {
  if (envelope.code !== 0) throw new ApiError(envelope.msg || '操作失败', { status: 400, code: envelope.code });
  return envelope;
}

/**
 * 读操作取数据：校验信封并解出 `data`。
 *
 * 各 feature 的 api 模块此前各自实现了一份 `unwrap`（3 份逐字复制 + 若干内联变体），
 * 行为修正要改 8 处——统一收敛到这里，错误一律是 `ApiError`（带 code 与 msg）。
 */
export async function expectData<T>(promise: Promise<ApiEnvelope<T>>): Promise<T> {
  const envelope = await promise;
  if (envelope.code !== 0) {
    throw new ApiError(envelope.msg || '请求失败', { status: 400, code: envelope.code });
  }
  return envelope.data;
}


/**
 * 读列表：信封校验后取数组；非数组（后端改形状/空值）一律回落为空数组，避免页面崩。
 */
export async function expectDataList<T>(promise: Promise<ApiEnvelope<unknown>>): Promise<T[]> {
  const data = await expectData(promise);
  return Array.isArray(data) ? (data as T[]) : [];
}

/**
 * 原始 JSON 请求：只做 HTTP 层处理，强制要求 `{ code, data, msg }` 信封。
 *
 * 例外场景：MCP 的 /mcp/oauth/authorize 按 OAuth 协议返回裸 `{ redirect_url }` 或
 * `{ error, error_description }`（标准错误形状），无法套信封。这类端点走 `requestRaw`，
 * 由调用方自己判 ok + 解析错误，避免"看起来成功实际抛 Malformed API response"。
 */
export async function requestRaw<T>(path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T | null }> {
  const response = await fetch(`${apiBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`, {
    method: 'POST',
    credentials: 'include',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload: T | null = null;
  if (text) {
    try { payload = JSON.parse(text) as T; } catch { payload = null; }
  }
  return { ok: response.ok, status: response.status, data: payload };
}

export const http = {
  get: <T>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>(path, { ...options, method: 'POST', body }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>(path, { ...options, method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: 'DELETE' }),

  // ── 写操作：默认校验信封 ────────────────────────────────────────────────
  // 写接口普遍不返回业务数据、调用方容易忘记判 code，而后端多处是「HTTP 200 + code:-1」，
  // 于是「保存失败却提示成功」。这四个方法把 ensureOk 内建进去，默认就是安全的；
  // 需要自己检查 code 的场景（登录 -2、找回密码）仍用 post/put 原始方法。
  postOk: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'POST', body }).then(ensureOk),
  putOk: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'PUT', body }).then(ensureOk),
  patchOk: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'PATCH', body }).then(ensureOk),
  deleteOk: <T>(path: string, options?: RequestOptions) =>
    request<T>(path, { ...options, method: 'DELETE' }).then(ensureOk),
};
