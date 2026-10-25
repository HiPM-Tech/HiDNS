import { http } from '../../lib/http';

export type DbType = 'sqlite' | 'mysql' | 'postgresql';

export interface SqliteConfig { path: string }
export interface ServerDbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
}

export interface DbConfig {
  type: DbType;
  sqlite: SqliteConfig;
  mysql: ServerDbConfig;
  postgresql: ServerDbConfig;
}

export interface SetupStatus {
  initialized?: boolean;
  dbInitialized?: boolean;
  hasUsers?: boolean;
}

export interface TestDbResult {
  success: boolean;
  message?: string;
  hasExistingData?: boolean;
}

export interface InitDbResult {
  success?: boolean;
  skipToComplete?: boolean;
  skipToUserCreation?: boolean;
  message?: string;
}

export const DEFAULT_DB_CONFIG: DbConfig = {
  type: 'sqlite',
  sqlite: { path: './data/hidns.db' },
  mysql: { host: 'localhost', port: 3306, database: 'HiDNS', user: 'root', password: '', ssl: false },
  postgresql: { host: 'localhost', port: 5432, database: 'HiDNS', user: 'postgres', password: '', ssl: false },
};

async function unwrap<T>(promise: Promise<import('../../lib/http').ApiEnvelope<T>>): Promise<T> {
  const envelope = await promise;
  if (envelope.code !== 0) throw new Error(envelope.msg || '请求失败');
  return envelope.data;
}

export function buildDbPayload(config: DbConfig, reset = false) {
  const base: Record<string, unknown> = { type: config.type };
  if (config.type === 'sqlite') base.sqlite = { path: config.sqlite.path };
  else base[config.type] = config[config.type];
  if (reset) base.reset = true;
  return base;
}

export const setupApi = {
  status: () => unwrap(http.get<SetupStatus>('/init/status')),
  dbConfig: async (): Promise<Partial<DbConfig> | null> => {
    try {
      return await unwrap(http.get<Partial<DbConfig> | null>('/init/db-config'));
    } catch {
      return null;
    }
  },
  testDb: (config: DbConfig) => unwrap(http.post<TestDbResult>('/init/test-db', buildDbPayload(config))),
  initDb: (config: DbConfig, reset = false) => unwrap(http.post<InitDbResult>('/init/database', buildDbPayload(config, reset))),
  createAdmin: async (payload: { username: string; email: string; password: string }) =>
    unwrap(http.post<{ success?: boolean }>('/init/admin', payload)),
};

export function mergeDbConfig(remote?: Partial<DbConfig> | null): DbConfig {
  if (!remote) return DEFAULT_DB_CONFIG;
  const type = (['sqlite', 'mysql', 'postgresql'] as DbType[]).includes(remote.type as DbType) ? (remote.type as DbType) : 'sqlite';
  return {
    type,
    sqlite: { path: String(remote.sqlite?.path || DEFAULT_DB_CONFIG.sqlite.path) },
    mysql: { ...DEFAULT_DB_CONFIG.mysql, ...remote.mysql },
    postgresql: { ...DEFAULT_DB_CONFIG.postgresql, ...remote.postgresql },
  };
}

export function validateAdminForm(form: { username: string; email: string; password: string; confirmPassword: string }): string | null {
  if (!form.username || !form.email || !form.password) return '请填写全部字段';
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(form.username)) return '用户名需为 3–20 位字母、数字或下划线';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return '邮箱格式不正确';
  if (form.password.length < 6) return '密码至少 6 位';
  if (form.password !== form.confirmPassword) return '两次输入的密码不一致';
  return null;
}
