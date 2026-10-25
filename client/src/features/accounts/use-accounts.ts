import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createAccount, deleteAccount, listAccounts, listProviders, updateAccount,
  type AccountPayload, type AccountQuery,
} from './api';

export function useAccounts(query: AccountQuery) {
  return useQuery({
    queryKey: ['accounts', query],
    queryFn: () => listAccounts(query),
    staleTime: 30_000,
  });
}

export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: listProviders,
    staleTime: 10 * 60_000,
  });
}

function useInvalidateAccounts() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['accounts'] });
    void queryClient.invalidateQueries({ queryKey: ['domain-accounts'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };
}

export function useSaveAccount() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    // 新建返回 { id }、更新返回 null：统一收敛为 unknown，避免联合类型与 MutationFunction 冲突
    mutationFn: async ({ id, payload }: { id?: number; payload: AccountPayload }): Promise<unknown> =>
      id ? updateAccount(id, payload) : createAccount(payload),
    onSuccess: invalidate,
  });
}

export function useDeleteAccount() {
  const invalidate = useInvalidateAccounts();
  return useMutation({
    mutationFn: (id: number) => deleteAccount(id),
    onSuccess: invalidate,
  });
}
