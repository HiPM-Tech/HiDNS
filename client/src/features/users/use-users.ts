import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usersApi, type CreateUserPayload, type UpdateUserPayload } from './api';

export function useUsers() {
  return useQuery({ queryKey: ['users'], queryFn: usersApi.list, staleTime: 30_000 });
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => { void queryClient.invalidateQueries({ queryKey: ['users'] }); };
}

export function useCreateUser() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (payload: CreateUserPayload) => usersApi.create(payload), onSuccess: invalidate });
}

export function useUpdateUser() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: UpdateUserPayload }) => usersApi.update(id, payload),
    onSuccess: invalidate,
  });
}

export function useDeleteUser() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: number) => usersApi.remove(id), onSuccess: invalidate });
}
