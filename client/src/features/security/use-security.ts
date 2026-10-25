import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiEnvelope } from '../../lib/http';
import { securityApi, type SecurityPolicy } from './api';

/** 查询钩子统一解包信封：`code !== 0` 视为错误，组件只拿到业务数据 */
function unwrap<T>(request: () => Promise<ApiEnvelope<T>>): Promise<T> {
  return request().then((envelope) => {
    if (envelope.code !== 0) throw new Error(envelope.msg || '请求失败');
    return envelope.data;
  });
}

export function useTwoFactorStatus() {
  return useQuery({ queryKey: ['security', '2fa'], queryFn: () => unwrap(securityApi.twoFactorStatus), staleTime: 30_000 });
}

export function usePasskeys() {
  return useQuery({ queryKey: ['security', 'passkeys'], queryFn: () => unwrap(securityApi.listPasskeys), staleTime: 30_000 });
}

export function useDeletePasskey() {
  const invalidate = useInvalidate(['passkeys']);
  return useMutation({ mutationFn: securityApi.deletePasskey, onSuccess: invalidate });
}

export function useTrustedDevices() {
  return useQuery({ queryKey: ['security', 'devices'], queryFn: () => unwrap(securityApi.trustedDevices), staleTime: 30_000 });
}

export function useSecurityPolicy(enabled: boolean) {
  return useQuery({
    queryKey: ['security', 'policy'],
    queryFn: () => unwrap(securityApi.getPolicy),
    staleTime: 60_000,
    enabled,
  });
}

function useInvalidate(keys: string[]) {
  const queryClient = useQueryClient();
  return () => { for (const key of keys) void queryClient.invalidateQueries({ queryKey: ['security', key] }); };
}

export function useEnableTwoFactor() {
  const invalidate = useInvalidate(['2fa']);
  return useMutation({ mutationFn: securityApi.enableTwoFactor, onSuccess: invalidate });
}

export function useDisableTwoFactor() {
  const invalidate = useInvalidate(['2fa']);
  return useMutation({ mutationFn: securityApi.disableTwoFactor, onSuccess: invalidate });
}

export function useRemoveTrustedDevice() {
  const invalidate = useInvalidate(['devices']);
  return useMutation({ mutationFn: securityApi.removeTrustedDevice, onSuccess: invalidate });
}

export function useRemoveAllTrustedDevices() {
  const invalidate = useInvalidate(['devices']);
  return useMutation({ mutationFn: securityApi.removeAllTrustedDevices, onSuccess: invalidate });
}

export function useUpdateSecurityPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (policy: Partial<SecurityPolicy>) => securityApi.updatePolicy(policy),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['security', 'policy'] }); },
  });
}
