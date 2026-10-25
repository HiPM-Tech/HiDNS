import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { renewalApi, type RenewableQuery } from './renewal-api';

export function useRenewableDomains(query: RenewableQuery) {
  return useQuery({ queryKey: ['renewable-domains', query], queryFn: () => renewalApi.list(query), staleTime: 30_000 });
}

export function useProviderDomains(accountId: number | null) {
  return useQuery({
    queryKey: ['provider-domains', accountId],
    queryFn: () => renewalApi.providerDomains(accountId as number),
    enabled: accountId != null,
    staleTime: 60_000,
  });
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => { void queryClient.invalidateQueries({ queryKey: ['renewable-domains'] }); };
}

export function useToggleRenewable() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => renewalApi.toggle(id, enabled),
    onSuccess: invalidate,
  });
}

export function useDeleteRenewable() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: number) => renewalApi.remove(id), onSuccess: invalidate });
}

export function useRenewDomain() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (domainId: number) => renewalApi.renew(domainId), onSuccess: invalidate });
}

export function useAddRenewable() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ accountId, providerType, domains }: {
      accountId: number;
      providerType?: string;
      domains: Array<{ name: string; third_id?: string; expires_at?: string | null }>;
    }) => {
      const results: Array<{ ok: boolean; error?: string }> = [];
      for (const domain of domains) {
        try {
          await renewalApi.add({
            account_id: accountId,
            provider_type: providerType,
            domain_name: domain.name,
            third_id: domain.third_id ?? '',
            full_domain: domain.name,
            expires_at: domain.expires_at ?? undefined,
          });
          results.push({ ok: true });
        } catch (err) {
          results.push({ ok: false, error: err instanceof Error ? err.message : '添加失败' });
        }
      }
      return results;
    },
    onSuccess: invalidate,
  });
}
