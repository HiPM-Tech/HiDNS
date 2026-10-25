import { http } from '../../lib/http';

export interface SystemInfo {
  version: string;
  serverVersion?: string;
  database?: { type?: string; version?: string; driverVersion?: string };
  timezone?: string;
  isCIBuild?: boolean;
}

export interface SystemVersionInfo {
  version?: string;
  deployMode?: string;
  logLevel?: string;
  node?: string;
  uptime?: number;
  dbConnected?: boolean;
  nodeVersion?: string;
  /** 后端实际把运行状态放在 nodeStatus 下（历史字段 uptime/dbConnected 仍兼容） */
  nodeStatus?: { status?: string; uptime?: number; startTime?: string; dbConnected?: boolean };
}

export const systemApi = {
  info: async (): Promise<SystemInfo> => {
    const envelope = await http.get<SystemInfo>('/system/info');
    if (envelope.code !== 0) throw new Error(envelope.msg || '获取系统信息失败');
    return envelope.data;
  },
  version: async (): Promise<SystemVersionInfo> => {
    const envelope = await http.get<SystemVersionInfo>('/system/version');
    if (envelope.code !== 0) throw new Error(envelope.msg || '获取版本信息失败');
    return envelope.data;
  },
};

export function formatUptime(seconds?: number): string {
  if (!seconds || seconds < 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}
