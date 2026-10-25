import { ApiError, http } from '../../lib/http';

export interface SessionUser {
  id: number;
  username: string;
  nickname?: string;
  email?: string;
  role?: string;
  role_level?: number;
  avatar?: string;
}

/** 3 秒内复用同一次 /auth/me，避免新壳与旧 AuthContext 各打一次 */
let meCache: { at: number; value: Promise<SessionUser | null> } | null = null;

export const sessionApi = {
  me: async (): Promise<SessionUser | null> => {
    const now = Date.now();
    if (meCache && now - meCache.at < 3000) return meCache.value;

    const request = (async () => {
      try {
        const envelope = await http.get<SessionUser>('/auth/me');
        return envelope.code === 0 ? envelope.data : null;
      } catch (error) {
        // 401 表示未登录（返回 null）；其余错误必须抛出，否则「服务端 500」会被当成「未登录」
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    })();

    meCache = { at: now, value: request };
    try {
      return await request;
    } catch (error) {
      meCache = null;
      throw error;
    }
  },
  /** 清空缓存（登录/登出后调用） */
  invalidate: (): void => { meCache = null; },
  logout: async (): Promise<void> => {
    try {
      await http.postOk<null>('/auth/logout');
    } finally {
      meCache = null;
      window.location.assign('/login');
    }
  },
};
