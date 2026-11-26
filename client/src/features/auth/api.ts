import { http, type ApiEnvelope } from '../../lib/http';

/** 登录成功后服务端返回的最小用户视图（完整用户模型随账号模块迁移后再引入） */
export interface AuthUser {
  id: number;
  username: string;
  nickname?: string;
  role?: string;
  role_level?: number;
}

export interface LoginPayload {
  username: string;
  password: string;
  totpCode?: string;
  backupCode?: string;
  /** 邮箱验证码第二因子（issue #43） */
  emailCode?: string;
  encrypted?: boolean;
  webauthnResponse?: unknown;
}

export interface OAuthStatus {
  enabled: boolean;
  providerName?: string;
  providers?: Array<{ key?: string; providerName?: string }>;
}

export interface LoginResult {
  token?: string;
  user?: AuthUser;
  /** 需要 2FA 时返回支持的验证方式 */
  types?: string[];
}

export const authApi = {
  login: (payload: LoginPayload): Promise<ApiEnvelope<LoginResult>> => http.post<LoginResult>('/auth/login', payload),
  /** 发送登录用邮箱验证码（第二因子，issue #43） */
  /** 通行密钥免密登录：不需要密码，凭据本身即登录凭证 */
  passkeyLogin: (payload: { username: string; webauthnResponse: unknown }) =>
    http.post<{ user?: unknown }>('/auth/webauthn/login', payload),

  /** 用一次性凭证完成 OAuth 登录的第二因子（OAuth 用户通常没有密码） */
  oauth2fa: (payload: { pendingToken: string; totpCode?: string; backupCode?: string; emailCode?: string; webauthnResponse?: unknown }) =>
    // 用原始 post：需要读 -4（邮箱未验证），postOk 会把非 0 当错误抛出
    http.post<{ user?: unknown; requireEmailVerification?: boolean; email?: string; pendingToken?: string }>('/auth/oauth/2fa', payload),

  /** 为「登录后强制验证邮箱」发码（未登录可用，purpose=profile） */
  requestEmailVerificationCode: (pendingToken: string) =>
    http.postOk<{ sent: boolean }>('/auth/verify-email/code', { pendingToken }),

  /** 验证邮箱（登录后强制验证流程）：只校验验证码，通过后需要重新登录 */
  verifyEmail: (pendingToken: string, code: string) =>
    http.postOk<{ verified: boolean; require2FA?: boolean; types?: string[]; user?: unknown }>('/auth/verify-email', { pendingToken, code }),

  loginEmailCode: (username: string): Promise<ApiEnvelope<{ sent: boolean }>> =>
    http.post<{ sent: boolean }>('/auth/login/email-code', { username }),
  me: (): Promise<ApiEnvelope<AuthUser>> => http.get<AuthUser>('/auth/me'),
  logout: (): Promise<ApiEnvelope<null>> => http.postOk<null>('/auth/logout'),
  // 服务端把 PublicKeyCredentialRequestOptionsJSON 直接放在 data 里（没有再包一层 options）
  webauthnLoginOptions: (username: string): Promise<ApiEnvelope<unknown>> =>
    http.get<unknown>('/auth/webauthn/login-options', { query: { username } }),
  oauthStatus: (): Promise<ApiEnvelope<OAuthStatus>> => http.get<OAuthStatus>('/auth/oauth/status'),
  oauthStart: (provider?: string): Promise<ApiEnvelope<{ authUrl: string }>> =>
    http.post<{ authUrl: string }>('/auth/oauth/start', provider ? { provider } : {}),
  requestPasswordReset: (email: string): Promise<ApiEnvelope<null>> =>
    http.post<null>('/auth/password-reset/request', { email }),
  confirmPasswordReset: (email: string, code: string, newPassword: string, encrypted = true): Promise<ApiEnvelope<null>> =>
    http.post<null>('/auth/password-reset/confirm', { email, code, newPassword, encrypted }),
};
