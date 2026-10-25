import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteDomain, listDomainAccounts, listDomains, updateDomain, type DomainQuery } from './api';

export function useDomains(query: DomainQuery) {
  return useQuery({
    queryKey: ['domains', query],
    queryFn: () => listDomains(query),
    staleTime: 15_000,
  });
}

export function useDomainAccounts() {
  return useQuery({
    queryKey: ['domain-accounts'],
    queryFn: listDomainAccounts,
    staleTime: 60_000,
  });
}

function useInvalidateDomains() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['domains'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };
}

export function useToggleDomain() {
  const invalidate = useInvalidateDomains();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => updateDomain(id, { enabled: enabled ? 1 : 0 }),
    onSuccess: invalidate,
  });
}

export function useUpdateDomainRemark() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, remark }: { id: number; remark: string }) => updateDomain(id, { remark }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['domains'] }); },
  });
}

export function useDeleteDomain() {
  const invalidate = useInvalidateDomains();
  return useMutation({
    mutationFn: (id: number) => deleteDomain(id),
    onSuccess: invalidate,
  });
}
