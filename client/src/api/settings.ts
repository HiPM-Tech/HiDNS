import { api } from './client';
import type { ApiResponse } from './client';
import type { 
  SystemInfo, LoginLimitConfig, LoginAttemptStats, JwtSecretInfo, 
  SmtpConfig, SecurityConfig, OAuthConfig 
} from './types';

// ─── System API ───────────────────────────────────────────────────────────────

export const systemApi = {
  info: () => api.get<ApiResponse<SystemInfo>>('/system/info'),
};

// ─── Settings API ─────────────────────────────────────────────────────────────

export const settingsApi = {
  getJwtSecret: (password: string) => api.post<ApiResponse<JwtSecretInfo>>('/settings/jwt-secret', { password }),
  getSmtpConfig: () => api.get<ApiResponse<SmtpConfig>>('/settings/smtp'),
  updateSmtpConfig: (data: Partial<SmtpConfig>) => api.put<ApiResponse<SmtpConfig>>('/settings/smtp', data),
  sendSmtpTest: (to?: string) => api.post<ApiResponse<null>>('/settings/smtp/test', { to }),
  getSecurityConfig: () => api.get<ApiResponse<SecurityConfig>>('/settings/security'),
  updateSecurityConfig: (data: Partial<SecurityConfig>) => api.put<ApiResponse<SecurityConfig>>('/settings/security', data),
  getOAuthConfig: () => api.get<ApiResponse<OAuthConfig>>('/settings/oauth'),
  updateOAuthConfig: (data: Partial<OAuthConfig>) => api.put<ApiResponse<OAuthConfig>>('/settings/oauth', data),
  getLogtoOAuthConfig: () => api.get<ApiResponse<OAuthConfig>>('/settings/oauth/logto'),
  updateLogtoOAuthConfig: (data: Partial<OAuthConfig>) => api.put<ApiResponse<OAuthConfig>>('/settings/oauth/logto', data),
  discoverOidc: (issuer: string) => api.post<ApiResponse<Partial<OAuthConfig>>>('/settings/oauth/oidc-discover', { issuer }),
  getLoginLimit: () => api.get<ApiResponse<LoginLimitConfig>>('/settings/login-limit'),
  updateLoginLimit: (data: Partial<LoginLimitConfig>) =>
    api.put<ApiResponse<LoginLimitConfig>>('/settings/login-limit', data),
  getLoginAttemptStats: () => api.get<ApiResponse<LoginAttemptStats>>('/settings/login-attempts/stats'),
  unlockAccount: (identifier: string) =>
    api.post<ApiResponse<null>>('/settings/login-attempts/unlock', { identifier }),
  // 工作流出站白名单（设计 §5.5.1）：此前只有后端接口，前端没有任何入口
  getWorkflowHttpAllowlist: () => api.get<ApiResponse<{ allowlist: string[] }>>('/settings/workflow-http-allowlist'),
  updateWorkflowHttpAllowlist: (allowlist: string[]) =>
    api.put<ApiResponse<{ allowlist: string[] }>>('/settings/workflow-http-allowlist', { allowlist }),
  getNotificationChannels: () => api.get<ApiResponse<any[]>>('/settings/notifications'),
  updateNotificationChannels: (channels: any[]) => api.put<ApiResponse<any>>('/settings/notifications', { channels }),
  getAuditRules: () => api.get<ApiResponse<any>>('/settings/audit-rules'),
  updateAuditRules: (rules: any) => api.put<ApiResponse<any>>('/settings/audit-rules', { rules }),
};

// ─── Security API ─────────────────────────────────────────────────────────────

export const securityApi = {
  getPolicy: () => api.get<ApiResponse<any>>('/security/policy'),
  updatePolicy: (data: Partial<any>) => api.put<ApiResponse<any>>('/security/policy', data),
  getUser2FARequirement: (userId: number) => api.get<ApiResponse<{ require2FA: boolean; configuredRequire2FA?: boolean; global2FAEnabled?: boolean }>>(`/security/users/${userId}/require-2fa`),
  setUser2FARequirement: (userId: number, require2FA: boolean) =>
    api.put<ApiResponse<{ require2FA: boolean; configuredRequire2FA?: boolean; global2FAEnabled?: boolean }>>(`/security/users/${userId}/require-2fa`, { require2FA }),
};
