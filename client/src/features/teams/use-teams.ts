import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { teamsApi, type PermissionInput } from './api';

export function useTeams() {
  return useQuery({ queryKey: ['teams'], queryFn: teamsApi.list, staleTime: 30_000 });
}

export function useTeamMembers(teamId: number | null) {
  return useQuery({
    queryKey: ['team-members', teamId],
    queryFn: () => teamsApi.members(teamId as number),
    enabled: teamId != null,
    staleTime: 15_000,
  });
}

export function useTeamPermissions(teamId: number | null) {
  return useQuery({
    queryKey: ['team-permissions', teamId],
    queryFn: () => teamsApi.teamPermissions(teamId as number),
    enabled: teamId != null,
    staleTime: 15_000,
  });
}

export function useMemberPermissions(teamId: number | null, userId: number | null) {
  return useQuery({
    queryKey: ['member-permissions', teamId, userId],
    queryFn: () => teamsApi.memberPermissions(teamId as number, userId as number),
    enabled: teamId != null && userId != null,
    staleTime: 15_000,
  });
}

export function useUserOptions() {
  return useQuery({ queryKey: ['team-user-options'], queryFn: teamsApi.users, staleTime: 60_000 });
}

export function useDomainOptions() {
  return useQuery({ queryKey: ['team-domain-options'], queryFn: teamsApi.domains, staleTime: 60_000 });
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return (keys: string[]) => { for (const key of keys) void queryClient.invalidateQueries({ queryKey: [key] }); };
}

export function useSaveTeam() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, payload }: { id?: number; payload: { name: string; description?: string } }) =>
      id ? teamsApi.update(id, payload) : teamsApi.create(payload) as Promise<unknown>,
    onSuccess: () => invalidate(['teams']),
  });
}

export function useDeleteTeam() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) => teamsApi.remove(id),
    onSuccess: () => invalidate(['teams']),
  });
}

export function useAddMember(teamId: number | null) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (userId: number) => teamsApi.addMember(teamId as number, userId),
    onSuccess: () => invalidate(['team-members', 'teams']),
  });
}

export function useRemoveMember(teamId: number | null) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (userId: number) => teamsApi.removeMember(teamId as number, userId),
    onSuccess: () => invalidate(['team-members', 'teams']),
  });
}

export function useUpdateMemberRole(teamId: number | null) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: number; role: 'admin' | 'member' }) =>
      teamsApi.updateMemberRole(teamId as number, userId, role),
    onSuccess: () => invalidate(['team-members']),
  });
}

export function useAddPermission(teamId: number | null, userId: number | null) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (payload: PermissionInput) =>
      userId == null
        ? teamsApi.addTeamPermission(teamId as number, payload)
        : teamsApi.addMemberPermission(teamId as number, userId, payload),
    onSuccess: () => invalidate(['team-permissions', 'member-permissions']),
  });
}

export function useRemovePermission(teamId: number | null, userId: number | null) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (permissionId: number) =>
      userId == null
        ? teamsApi.removeTeamPermission(teamId as number, permissionId)
        : teamsApi.removeMemberPermission(teamId as number, userId, permissionId),
    onSuccess: () => invalidate(['team-permissions', 'member-permissions']),
  });
}
