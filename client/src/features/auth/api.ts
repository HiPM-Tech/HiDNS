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
  me: (): Promise<ApiEnvelope<AuthUser>> => http.get<AuthUser>('/auth/me'),
  logout: (): Promise<ApiEnvelope<null>> => http.postOk<null>('/auth/logout'),
  webauthnLoginOptions: (username: string): Promise<ApiEnvelope<{ options: unknown }>> =>
    http.get<{ options: unknown }>('/auth/webauthn/login-options', { query: { username } }),
  oauthStatus: (): Promise<ApiEnvelope<OAuthStatus>> => http.get<OAuthStatus>('/auth/oauth/status'),
  oauthStart: (provider?: string): Promise<ApiEnvelope<{ authUrl: string }>> =>
    http.post<{ authUrl: string }>('/auth/oauth/start', provider ? { provider } : {}),
  requestPasswordReset: (email: string): Promise<ApiEnvelope<null>> =>
    http.post<null>('/auth/password-reset/request', { email }),
  confirmPasswordReset: (email: string, code: string, newPassword: string, encrypted = true): Promise<ApiEnvelope<null>> =>
    http.post<null>('/auth/password-reset/confirm', { email, code, newPassword, encrypted }),
};
