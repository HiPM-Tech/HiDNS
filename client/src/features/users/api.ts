import { expectData, http } from '../../lib/http';

export interface UserRow {
  id: number;
  username: string;
  nickname?: string | null;
  email?: string | null;
  role: number | string;
  status?: number;
  created_at?: string;
}

export interface CreateUserPayload {
  username: string;
  password: string;
  nickname?: string;
  email?: string;
  role?: number;
}

export interface UpdateUserPayload {
  nickname?: string;
  email?: string;
  role?: number;
  status?: number;
  password?: string;
}

export interface User2faRequirement {
  require2FA?: boolean;
  configuredRequire2FA?: boolean;
  global2FAEnabled?: boolean;
}

export const usersApi = {
  list: async (): Promise<UserRow[]> => {
    const data = await expectData(http.get<UserRow[] | { list?: UserRow[] }>('/users'));
    return Array.isArray(data) ? data : (data?.list ?? []);
  },
  create: (payload: CreateUserPayload) => http.postOk<{ id: number }>('/users', payload),
  update: (id: number, payload: UpdateUserPayload) => http.putOk<null>(`/users/${id}`, payload),
  remove: (id: number) => http.deleteOk<null>(`/users/${id}`),
  twoFactorRequirement: (userId: number) => expectData(http.get<User2faRequirement>(`/security/users/${userId}/require-2fa`)),
  setTwoFactorRequirement: (userId: number, require2FA: boolean) =>
    http.putOk<null>(`/security/users/${userId}/require-2fa`, { require2FA }),
};

export const ROLE_USER = 1;
export const ROLE_ADMIN = 2;
export const ROLE_SUPER = 3;

export function roleLevel(user: UserRow): number {
  const numeric = Number(user.role);
  if (Number.isFinite(numeric)) return numeric;
  const role = String(user.role ?? '').toLowerCase();
  if (role === 'super_admin' || role === 'superadmin') return ROLE_SUPER;
  if (role === 'admin') return ROLE_ADMIN;
  return ROLE_USER;
}

export function roleLabel(level: number): string {
  if (level >= ROLE_SUPER) return '超级管理员';
  if (level >= ROLE_ADMIN) return '管理员';
  return '普通用户';
}

export function isActive(user: UserRow): boolean {
  return user.status === undefined || user.status === null ? true : Number(user.status) === 1;
}

/** 可创建/可分配的角色：超管可建管理员，管理员只能建普通用户 */
export function assignableRoles(callerLevel: number): number[] {
  if (callerLevel >= ROLE_SUPER) return [ROLE_USER, ROLE_ADMIN];
  if (callerLevel >= ROLE_ADMIN) return [ROLE_USER];
  return [ROLE_USER];
}
