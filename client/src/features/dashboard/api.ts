import { http } from '../../lib/http';

export interface DashboardDomain {
  id: number;
  name: string;
  account_id: number;
  record_count?: number;
  expires_at?: string;
  enabled?: number;
}

export interface DashboardAccount {
  id: number;
  name: string;
  type: string;
  enabled?: boolean | number;
}

export interface DashboardUser {
  id: number;
  username: string;
  nickname?: string;
  role?: string;
}

export interface DashboardLog {
  id: number;
  action: string;
  domain?: string;
  username?: string;
  created_at?: string;
}

export interface DashboardSnapshot {
  domains: DashboardDomain[];
  domainTotal: number;
  accounts: DashboardAccount[];
  users: DashboardUser[] | null;
  logs: DashboardLog[] | null;
  /** 最近 24 小时操作数（在数据层计算，避免组件渲染期调用 Date.now()） */
  last24h: number;
}

interface Paged<T> { list?: T[]; total?: number }

async function listDomains(): Promise<{ list: DashboardDomain[]; total: number }> {
  const envelope = await http.get<Paged<DashboardDomain>>('/domains', { query: { page: 1, pageSize: 100 } });
  const data = envelope.data ?? {};
  return { list: data.list ?? [], total: data.total ?? (data.list?.length ?? 0) };
}

async function listAccounts(): Promise<DashboardAccount[]> {
  const envelope = await http.get<DashboardAccount[] | Paged<DashboardAccount>>('/accounts');
  const data = envelope.data;
  return Array.isArray(data) ? data : (data?.list ?? []);
}

async function listUsers(): Promise<DashboardUser[] | null> {
  try {
    const envelope = await http.get<DashboardUser[]>('/users');
    return Array.isArray(envelope.data) ? envelope.data : null;
  } catch {
    return null; // 非管理员：/users 返回 403，仪表盘不展示该卡片
  }
}

async function listRecentLogs(): Promise<DashboardLog[] | null> {
  try {
    const envelope = await http.get<Paged<DashboardLog>>('/logs', { query: { page: 1, pageSize: 50 } });
    return envelope.data?.list ?? [];
  } catch {
    return null;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function fetchDashboard(): Promise<DashboardSnapshot> {
  const [domains, accounts, users, logs] = await Promise.all([
    listDomains(),
    listAccounts(),
    listUsers(),
    listRecentLogs(),
  ]);
  const cutoff = Date.now() - DAY_MS;
  const last24h = (logs ?? []).filter((log) => {
    if (!log.created_at) return false;
    const time = new Date(log.created_at).getTime();
    return Number.isFinite(time) && time >= cutoff;
  }).length;
  return { domains: domains.list, domainTotal: domains.total, accounts, users, logs, last24h };
}
