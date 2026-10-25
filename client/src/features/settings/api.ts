import { http } from '../../lib/http';

export interface Preferences {
  theme?: string;
  language?: string;
  notificationsEnabled?: boolean;
  emailNotifications?: boolean;
  backgroundImage?: string;
  avatarImage?: string;
}

/** 对应 oauth_user_links 表：provider / subject / email / created_at */
export interface OAuthBinding {
  provider: string;
  providerName?: string;
  subject?: string;
  email?: string;
  created_at?: string;
}

export const settingsApi = {
  updateProfile: (payload: { nickname?: string; email?: string; emailCode?: string }) =>
    http.putOk<{ id: number; username: string; nickname?: string; email?: string }>('/auth/profile', payload),
  sendEmailCode: (email: string) => http.postOk<null>('/auth/profile/email-code', { email }),
  changePassword: (oldPassword: string, newPassword: string, encrypted = true) =>
    http.putOk<null>('/auth/password', { oldPassword, newPassword, encrypted }),

  getPreferences: (): Promise<import('../../lib/http').ApiEnvelope<Preferences>> =>
    http.get<Preferences>('/auth/preferences'),
  updatePreferences: (payload: Preferences) => http.putOk<null>('/auth/preferences', payload),

  oauthBindings: (): Promise<import('../../lib/http').ApiEnvelope<OAuthBinding[]>> =>
    http.get<OAuthBinding[]>('/auth/oauth/bindings'),
  unbindOauth: (provider: string) => http.deleteOk<null>(`/auth/oauth/bindings/${encodeURIComponent(provider)}`),
  startOauthBind: (provider?: string) =>
    http.post<{ authUrl: string }>('/auth/oauth/start-bind', provider ? { provider } : {}),
};
