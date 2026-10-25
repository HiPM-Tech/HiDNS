import { expectDataList, http } from '../../lib/http';

export interface TeamRow {
  id: number;
  name: string;
  description?: string | null;
  created_by?: number | null;
  created_at?: string;
  member_count?: number;
  /** 当前用户在该团队中的角色：super（超管）| admin | member | undefined */
  my_role?: string | null;
}

export interface TeamMemberRow {
  id?: number;
  user_id?: number;
  userId?: number;
  username?: string;
  nickname?: string | null;
  role?: string;
  joined_at?: string;
  created_at?: string;
}

export interface PermissionRow {
  id: number;
  domain_id: number;
  domain_name?: string;
  permission?: 'read' | 'write';
  sub?: string | null;
  user_id?: number | null;
  username?: string | null;
}

export interface UserOption {
  id: number;
  username: string;
  nickname?: string | null;
}

export interface DomainOption {
  id: number;
  name: string;
}

export interface PermissionInput {
  domain_id: number;
  permission?: 'read' | 'write';
  sub?: string;
}

export const teamsApi = {
  list: () => expectDataList<TeamRow>(http.get('/teams')),
  create: (payload: { name: string; description?: string }) => http.postOk<{ id: number }>('/teams', payload),
  update: (id: number, payload: { name?: string; description?: string }) => http.putOk<null>(`/teams/${id}`, payload),
  remove: (id: number) => http.deleteOk<null>(`/teams/${id}`),

  members: (id: number) => expectDataList<TeamMemberRow>(http.get(`/teams/${id}/members`)),
  addMember: (id: number, userId: number, role = 'member') =>
    http.postOk<null>(`/teams/${id}/members`, { userId, role }),
  removeMember: (id: number, userId: number) => http.deleteOk<null>(`/teams/${id}/members/${userId}`),
  updateMemberRole: (id: number, userId: number, role: 'admin' | 'member') =>
    http.putOk<null>(`/teams/${id}/members/${userId}`, { role }),

  teamPermissions: (id: number) => expectDataList<PermissionRow>(http.get(`/teams/${id}/domain-permissions`)),
  addTeamPermission: (id: number, payload: PermissionInput) =>
    http.postOk<{ id: number }>(`/teams/${id}/domain-permissions`, payload),
  removeTeamPermission: (id: number, permissionId: number) =>
    http.deleteOk<null>(`/teams/${id}/domain-permissions/${permissionId}`),

  memberPermissions: (id: number, userId: number) =>
    expectDataList<PermissionRow>(http.get(`/teams/${id}/members/${userId}/domain-permissions`)),
  addMemberPermission: (id: number, userId: number, payload: PermissionInput) =>
    http.postOk<{ id: number }>(`/teams/${id}/members/${userId}/domain-permissions`, payload),
  removeMemberPermission: (id: number, userId: number, permissionId: number) =>
    http.deleteOk<null>(`/teams/${id}/members/${userId}/domain-permissions/${permissionId}`),

  users: () => expectDataList<UserOption>(http.get('/users')),
  domains: () => expectDataList<DomainOption>(http.get('/domains', { query: { pageSize: 100 } })),
};

/** 与服务端口径一致：超管、团队成员中的 admin、或团队创建者可管理；其余只读 */
export function canManageTeam(team: TeamRow | null, currentUserId: number, isSuper: boolean): boolean {
  if (!team) return false;
  if (isSuper) return true;
  if (team.my_role === 'super' || team.my_role === 'admin') return true;
  if (team.created_by != null && team.created_by === currentUserId) return true;
  return false;
}

export function memberUserId(member: TeamMemberRow): number {
  return Number(member.user_id ?? member.userId ?? 0);
}

export function memberLabel(member: TeamMemberRow): string {
  return member.nickname || member.username || `用户 #${memberUserId(member)}`;
}

export function permissionLabel(permission: PermissionRow): string {
  return permission.domain_name || `域名 #${permission.domain_id}`;
}
