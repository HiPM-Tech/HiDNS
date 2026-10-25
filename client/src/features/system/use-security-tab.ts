import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { systemSecurityApi, type AuditRules, type LoginLimitConfig, type SecurityConfig, type SmtpConfig } from './security-api';

export function useLoginLimit() {
  return useQuery({ queryKey: ['system-security', 'login-limit'], queryFn: systemSecurityApi.loginLimit, staleTime: 30_000 });
}
export function useLoginStats() {
  return useQuery({ queryKey: ['system-security', 'login-stats'], queryFn: systemSecurityApi.loginStats, staleTime: 15_000 });
}
export function useSmtpConfig() {
  return useQuery({ queryKey: ['system-security', 'smtp'], queryFn: systemSecurityApi.smtp, staleTime: 30_000 });
}
export function useSecurityConfig() {
  return useQuery({ queryKey: ['system-security', 'security-config'], queryFn: systemSecurityApi.securityConfig, staleTime: 30_000 });
}
export function useAuditRules() {
  return useQuery({ queryKey: ['system-security', 'audit-rules'], queryFn: systemSecurityApi.auditRules, staleTime: 30_000 });
}
export function useMcpConfig() {
  return useQuery({ queryKey: ['system-security', 'mcp'], queryFn: systemSecurityApi.mcpConfig, staleTime: 30_000 });
}

export function useOAuthConfig() {
  return useQuery({ queryKey: ['system-security', 'oauth'], queryFn: systemSecurityApi.oauthConfig, staleTime: 30_000 });
}

export function useLogtoConfig() {
  return useQuery({ queryKey: ['system-security', 'logto'], queryFn: systemSecurityApi.logtoConfig, staleTime: 30_000 });
}

export function useSaveOAuthConfig() {
  const invalidate = useInvalidate(['oauth']);
  return useMutation({ mutationFn: systemSecurityApi.updateOAuthConfig, onSuccess: invalidate });
}

export function useSaveLogtoConfig() {
  const invalidate = useInvalidate(['logto']);
  return useMutation({ mutationFn: systemSecurityApi.updateLogtoConfig, onSuccess: invalidate });
}

export function useDiscoverOidc() {
  return useMutation({ mutationFn: (issuer: string) => systemSecurityApi.discoverOidc(issuer) });
}

function useInvalidate(keys: string[]) {
  const queryClient = useQueryClient();
  return () => { for (const key of keys) void queryClient.invalidateQueries({ queryKey: ['system-security', key] }); };
}

export function useSaveLoginLimit() {
  const invalidate = useInvalidate(['login-limit']);
  return useMutation({ mutationFn: (payload: LoginLimitConfig) => systemSecurityApi.updateLoginLimit(payload), onSuccess: invalidate });
}
export function useUnlockAccount() {
  const invalidate = useInvalidate(['login-stats', 'login-limit']);
  return useMutation({ mutationFn: (identifier: string) => systemSecurityApi.unlock(identifier), onSuccess: invalidate });
}
export function useSaveSmtp() {
  const invalidate = useInvalidate(['smtp']);
  return useMutation({ mutationFn: (payload: SmtpConfig) => systemSecurityApi.updateSmtp(payload), onSuccess: invalidate });
}
export function useTestSmtp() {
  return useMutation({ mutationFn: (to: string) => systemSecurityApi.testSmtp(to) });
}
export function useSaveSecurityConfig() {
  const invalidate = useInvalidate(['security-config']);
  return useMutation({ mutationFn: (payload: SecurityConfig) => systemSecurityApi.updateSecurityConfig(payload), onSuccess: invalidate });
}
export function useSaveAuditRules() {
  const invalidate = useInvalidate(['audit-rules']);
  return useMutation({ mutationFn: (rules: AuditRules) => systemSecurityApi.updateAuditRules(rules), onSuccess: invalidate });
}
export function useSaveMcpConfig() {
  const invalidate = useInvalidate(['mcp']);
  return useMutation({ mutationFn: (enabled: boolean) => systemSecurityApi.updateMcpConfig(enabled), onSuccess: invalidate });
}
