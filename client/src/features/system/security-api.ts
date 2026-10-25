import { ensureOk, http } from '../../lib/http';

export interface LoginLimitConfig {
  enabled?: boolean;
  maxAttempts?: number;
  lockoutDuration?: number;
}

/** 与后端 service/smtp.ts 的 SmtpConfig 字段一一对应（username / password / fromEmail / fromName） */
export interface SmtpConfig {
  enabled?: boolean;
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  password?: string;
  fromEmail?: string;
  fromName?: string;
}

export interface SecurityConfig {
  jwtViewEmailNotify?: boolean;
  domainExpiryNotify?: boolean;
  domainExpiryDays?: number;
  showDnsProviderSecrets?: boolean;
}

export interface AuditRules {
  enabled?: boolean;
  maxDeletionsPerHour?: number;
  maxFailedLogins?: number;
  offHoursStart?: string;
  offHoursEnd?: string;
}

export type LoginStats = Array<Record<string, unknown>> | Record<string, unknown> | null;

export interface McpGlobalConfig {
  enabled?: boolean;
}

export interface OAuthConfig {
  enabled?: boolean;
  providerName?: string;
  subjectKey?: string;
  emailKey?: string;
  clientId?: string;
  clientSecret?: string;
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userInfoEndpoint?: string;
  jwksUri?: string;
  scopes?: string;
  redirectUri?: string;
}

export interface LogtoOAuthConfig extends OAuthConfig {
  logtoDomain?: string;
}

async function unwrap<T>(promise: Promise<import('../../lib/http').ApiEnvelope<T>>): Promise<T> {
  const envelope = await promise;
  if (envelope.code !== 0) throw new Error(envelope.msg || '请求失败');
  return envelope.data;
}

export const systemSecurityApi = {
  loginLimit: () => unwrap(http.get<LoginLimitConfig>('/settings/login-limit')),
  updateLoginLimit: async (payload: LoginLimitConfig) => ensureOk(await http.put<null>('/settings/login-limit', payload)),
  loginStats: () => unwrap(http.get<LoginStats>('/settings/login-attempts/stats')),
  unlock: (identifier: string) => http.postOk<null>('/settings/login-attempts/unlock', { identifier }),

  smtp: () => unwrap(http.get<SmtpConfig>('/settings/smtp')),
  updateSmtp: async (payload: SmtpConfig) => ensureOk(await http.put<SmtpConfig>('/settings/smtp', payload)),
  testSmtp: (to: string) => http.postOk<null>('/settings/smtp/test', { to }),

  securityConfig: () => unwrap(http.get<SecurityConfig>('/settings/security')),
  updateSecurityConfig: async (payload: SecurityConfig) => ensureOk(await http.put<null>('/settings/security', payload)),

  auditRules: () => unwrap(http.get<AuditRules>('/settings/audit-rules')),
  updateAuditRules: async (rules: AuditRules) => ensureOk(await http.put<null>('/settings/audit-rules', { rules })),

  mcpConfig: () => unwrap(http.get<McpGlobalConfig>('/mcp/config')),
  updateMcpConfig: async (enabled: boolean) => ensureOk(await http.post<null>('/mcp/config', { enabled })),

  jwtSecret: (password: string) => unwrap(http.post<{ jwtSecret?: string }>('/settings/jwt-secret', { password })),

  oauthConfig: () => unwrap(http.get<OAuthConfig>('/settings/oauth')),
  updateOAuthConfig: (payload: OAuthConfig) => http.putOk<OAuthConfig>('/settings/oauth', payload),
  discoverOidc: (issuer: string) => unwrap(http.post<Partial<OAuthConfig>>('/settings/oauth/oidc-discover', { issuer })),

  logtoConfig: () => unwrap(http.get<LogtoOAuthConfig>('/settings/oauth/logto')),
  updateLogtoConfig: (payload: LogtoOAuthConfig) => http.putOk<LogtoOAuthConfig>('/settings/oauth/logto', payload),
};
