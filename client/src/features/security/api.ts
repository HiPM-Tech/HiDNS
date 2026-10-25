import { http } from '../../lib/http';

export interface SecurityPolicy {
  require2FAGlobal: boolean;
  minPasswordLength: number;
  minPasswordStrength: number;
  sessionTimeoutHours: number;
  maxLoginAttempts: number;
  lockoutDurationMinutes: number;
  allowRememberDevice: boolean;
}

export interface TwoFactorStatus {
  configured: boolean;
  enabled: boolean;
  validationEnabled: boolean;
}

export interface TwoFactorSetup {
  secret: string;
  qrCode: string;
  backupCodes: string[];
}

export interface PasskeyRow {
  id: string;
  name?: string;
  deviceType?: string;
  created_at?: string;
  lastUsedAt?: string;
}

export interface TrustedDeviceRow {
  id?: number;
  deviceId?: string;
  device_id?: string;
  userAgent?: string;
  user_agent?: string;
  ipAddress?: string;
  ip_address?: string;
  createdAt?: string;
  created_at?: string;
  lastUsedAt?: string;
  last_used_at?: string;
}

export const securityApi = {
  getPolicy: (): Promise<import('../../lib/http').ApiEnvelope<SecurityPolicy>> =>
    http.get<SecurityPolicy>('/security/policy'),
  updatePolicy: (policy: Partial<SecurityPolicy>) => http.putOk<null>('/security/policy', policy),

  twoFactorStatus: (): Promise<import('../../lib/http').ApiEnvelope<TwoFactorStatus>> =>
    http.get<TwoFactorStatus>('/security/2fa-status'),
  setupTwoFactor: (): Promise<import('../../lib/http').ApiEnvelope<TwoFactorSetup>> =>
    http.postOk<TwoFactorSetup>('/security/2fa/setup'),
  enableTwoFactor: (payload: { secret: string; token: string; backupCodes: string[] }) =>
    http.postOk<null>('/security/2fa/enable', payload),
  disableTwoFactor: (payload: { token: string }) => http.postOk<null>('/security/2fa/disable', payload),

  listPasskeys: (): Promise<import('../../lib/http').ApiEnvelope<PasskeyRow[]>> =>
    http.get<PasskeyRow[]>('/auth/webauthn/credentials'),
  deletePasskey: (id: string) => http.deleteOk<null>(`/auth/webauthn/credentials/${encodeURIComponent(id)}`),
  passkeyRegistrationOptions: (): Promise<import('../../lib/http').ApiEnvelope<{ options: unknown }>> =>
    http.get<{ options: unknown }>('/auth/webauthn/registration-options'),
  passkeyRegistrationVerify: (credential: unknown) =>
    http.postOk<{ success: boolean }>('/auth/webauthn/registration-verify', { credential }),

  trustedDevices: (): Promise<import('../../lib/http').ApiEnvelope<TrustedDeviceRow[]>> =>
    http.get<TrustedDeviceRow[]>('/security/trusted-devices'),
  removeTrustedDevice: (deviceId: string) =>
    http.deleteOk<null>(`/security/trusted-devices/${encodeURIComponent(deviceId)}`),
  removeAllTrustedDevices: () => http.deleteOk<null>('/security/trusted-devices'),
};

/** 设备行字段兼容：不同数据库驱动返回 snake_case / camelCase 两种形态 */
export function deviceKey(device: TrustedDeviceRow): string {
  return String(device.deviceId ?? device.device_id ?? device.id ?? '');
}

export function deviceLabel(device: TrustedDeviceRow): string {
  const agent = device.userAgent ?? device.user_agent ?? '';
  if (agent) return agent.length > 60 ? `${agent.slice(0, 60)}…` : agent;
  return deviceKey(device) || '未知设备';
}

export function deviceMeta(device: TrustedDeviceRow): string {
  const ip = device.ipAddress ?? device.ip_address ?? '';
  const last = device.lastUsedAt ?? device.last_used_at ?? device.createdAt ?? device.created_at ?? '';
  const time = last ? new Date(last).toLocaleString('zh-CN') : '';
  return [ip, time].filter(Boolean).join(' · ');
}
