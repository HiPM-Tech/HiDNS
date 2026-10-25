import { ensureOk, http } from '../../lib/http';

export interface ProxyConfig {
  enabled: boolean;
  type: 'socks5' | 'http';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface ConnectivityResult {
  name: string;
  url: string;
  status: 'ok' | 'error' | 'timeout';
  latency?: number;
  error?: string;
}

export interface ConnectivityResponse {
  proxyEnabled: boolean;
  results: ConnectivityResult[];
}

export type NotificationChannelType = 'webhook' | 'telegram' | 'dingtalk' | 'email';

export interface NotificationChannel {
  id: string;
  type: NotificationChannelType;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
}

async function unwrap<T>(promise: Promise<import('../../lib/http').ApiEnvelope<T>>): Promise<T> {
  const envelope = await promise;
  if (envelope.code !== 0) throw new Error(envelope.msg || '请求失败');
  return envelope.data;
}

export const systemNetworkApi = {
  proxy: () => unwrap(http.get<ProxyConfig>('/network/proxy')),
  updateProxy: async (payload: ProxyConfig) => ensureOk(await http.post<ProxyConfig>('/network/proxy', payload)),
  connectivity: () => unwrap(http.get<ConnectivityResponse>('/network/connectivity')),

  allowlist: async (): Promise<string[]> => {
    const data = await unwrap(http.get<{ allowlist?: string[] }>('/settings/workflow-http-allowlist'));
    return Array.isArray(data.allowlist) ? data.allowlist : [];
  },
  updateAllowlist: async (allowlist: string[]) => ensureOk(await http.put<null>('/settings/workflow-http-allowlist', { allowlist })),

  channels: async (): Promise<NotificationChannel[]> => {
    const data = await unwrap(http.get<NotificationChannel[] | { list?: NotificationChannel[] }>('/settings/notifications'));
    return Array.isArray(data) ? data : (data?.list ?? []);
  },
  updateChannels: async (channels: NotificationChannel[]) => ensureOk(await http.put<null>('/settings/notifications', { channels })),
};

export function defaultChannelConfig(type: NotificationChannelType): Record<string, string> {
  if (type === 'webhook') return { url: '', method: 'POST' };
  if (type === 'telegram') return { botToken: '', chatId: '' };
  if (type === 'dingtalk') return { webhook: '' };
  return { to: '' };
}

export const CHANNEL_TYPE_LABELS: Record<NotificationChannelType, string> = {
  webhook: 'Webhook',
  telegram: 'Telegram',
  dingtalk: '钉钉',
  email: '邮件',
};
