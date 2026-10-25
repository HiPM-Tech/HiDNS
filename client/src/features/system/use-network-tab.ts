import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  systemNetworkApi, type NotificationChannel, type ProxyConfig,
} from './network-api';

export function useProxyConfig() {
  return useQuery({ queryKey: ['system-network', 'proxy'], queryFn: systemNetworkApi.proxy, staleTime: 30_000 });
}
export function useSaveProxy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ProxyConfig) => systemNetworkApi.updateProxy(payload),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['system-network', 'proxy'] }); },
  });
}
export function useConnectivity() {
  return useMutation({ mutationFn: () => systemNetworkApi.connectivity() });
}

export function useAllowlist() {
  return useQuery({ queryKey: ['system-network', 'allowlist'], queryFn: systemNetworkApi.allowlist, staleTime: 30_000 });
}
export function useSaveAllowlist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (allowlist: string[]) => systemNetworkApi.updateAllowlist(allowlist),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['system-network', 'allowlist'] }); },
  });
}

export function useChannels() {
  return useQuery({ queryKey: ['system-network', 'channels'], queryFn: systemNetworkApi.channels, staleTime: 30_000 });
}
export function useSaveChannels() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (channels: NotificationChannel[]) => systemNetworkApi.updateChannels(channels),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['system-network', 'channels'] }); },
  });
}
