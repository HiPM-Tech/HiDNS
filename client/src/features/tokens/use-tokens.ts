import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createToken, deleteToken, listTokenDomains, listTokens, toggleTokenStatus, updateToken,
  type TokenPayload,
} from './api';

export function useTokens() {
  return useQuery({ queryKey: ['tokens'], queryFn: listTokens, staleTime: 30_000 });
}

export function useTokenDomains() {
  return useQuery({ queryKey: ['token-domains'], queryFn: listTokenDomains, staleTime: 60_000 });
}

function useInvalidateTokens() {
  const queryClient = useQueryClient();
  return () => { void queryClient.invalidateQueries({ queryKey: ['tokens'] }); };
}

export function useCreateToken() {
  const invalidate = useInvalidateTokens();
  return useMutation({
    mutationFn: (payload: TokenPayload) => createToken(payload),
    onSuccess: invalidate,
  });
}

export function useUpdateToken() {
  const invalidate = useInvalidateTokens();
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: Partial<TokenPayload> }) => updateToken(id, payload),
    onSuccess: invalidate,
  });
}

export function useDeleteToken() {
  const invalidate = useInvalidateTokens();
  return useMutation({ mutationFn: (id: number) => deleteToken(id), onSuccess: invalidate });
}

export function useToggleToken() {
  const invalidate = useInvalidateTokens();
  return useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) => toggleTokenStatus(id, active),
    onSuccess: invalidate,
  });
}
