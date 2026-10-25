import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiEnvelope } from '../../lib/http';
import { settingsApi, type Preferences } from './api';

function unwrap<T>(request: () => Promise<ApiEnvelope<T>>): Promise<T> {
  return request().then((envelope) => {
    if (envelope.code !== 0) throw new Error(envelope.msg || '请求失败');
    return envelope.data;
  });
}

export function usePreferences() {
  return useQuery({ queryKey: ['settings', 'preferences'], queryFn: () => unwrap(settingsApi.getPreferences), staleTime: 60_000 });
}

export function useOauthBindings() {
  return useQuery({ queryKey: ['settings', 'oauth-bindings'], queryFn: () => unwrap(settingsApi.oauthBindings), staleTime: 60_000 });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: settingsApi.updateProfile,
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['session'] }); },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: ({ oldPassword, newPassword }: { oldPassword: string; newPassword: string }) =>
      settingsApi.changePassword(oldPassword, newPassword),
  });
}

export function useUpdatePreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: Preferences) => settingsApi.updatePreferences(payload),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['settings', 'preferences'] }); },
  });
}

export function useUnbindOauth() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: string) => settingsApi.unbindOauth(provider),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['settings', 'oauth-bindings'] }); },
  });
}
