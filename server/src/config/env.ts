import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { createLogger } from '../lib/logger';
import { resolveDefaultDbPath } from '../db/dal/config';

const log = createLogger('Config').sub('Env');
// Get the current working directory (where the server is running)
function getCwd(): string {
  return process.cwd();
}

// Load environment variables with priority:
// 1. ./data/.env (current working directory, highest priority)
// 2. .env (root directory)
// 3. process.env (lowest priority)

let loaded = false;

/**
 * 加载环境变量（幂等）。
 *
 * 注意：本模块在**求值期**就会自动调用一次（见文件末尾）。
 * 原因：`app.ts` 里显式 `loadEnv()` 是在所有 import 求值之后才执行的，
 * 而 `service/jwt.ts` 的模块级 IIFE 会先读 `process.env.JWT_SECRET`——
 * 结果 `data/.env` 里的密钥永远读不到，每次启动随机生成，重启后所有 JWT 失效。
 */
/** 进程启动时真实存在的环境变量：文件配置不得覆盖它们 */
const initialProcessEnv = { ...process.env };

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  const cwd = getCwd();
  const dataDir = path.join(cwd, 'data');

  // Ensure data directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dataEnvPath = path.join(dataDir, '.env');
  const rootEnvPath = path.join(cwd, '.env');

  log.info('Current working directory', { cwd });
  log.info('Looking for data/.env', { path: dataEnvPath });
  log.info('Looking for root .env', { path: rootEnvPath });

  // Load root .env first (lowest priority)
  if (fs.existsSync(rootEnvPath)) {
    log.info('Loading root .env');
    dotenv.config({ path: rootEnvPath });
  } else {
    log.info('Root .env not found');
  }

  // Load data/.env second（文件优先级高于 root .env，但**不得覆盖真实进程环境**）
  if (fs.existsSync(dataEnvPath)) {
    log.info('Loading data/.env');
    try {
      const parsed = dotenv.parse(fs.readFileSync(dataEnvPath));
      const overridden: string[] = [];
      for (const [key, value] of Object.entries(parsed)) {
        if (key in initialProcessEnv) { overridden.push(key); continue; }
        process.env[key] = value;
      }
      if (overridden.length > 0) {
        // 显式传入的环境变量（Docker -e / systemd Environment=）优先，避免部署配置被安装向导写的文件悄悄改掉
        log.info('Process environment takes precedence over data/.env', { keys: overridden });
      }
    } catch (error) {
      log.error('Error loading data/.env', { error });
    }
  } else {
    log.info('data/.env not found');
  }

  log.info('DB_TYPE after loading', { dbType: process.env.DB_TYPE || 'not set' });
}

// Save configuration to ./data/.env (current working directory)
export function saveEnvConfig(config: Record<string, string>): void {
  const cwd = getCwd();
  const dataDir = path.join(cwd, 'data');
  const envPath = path.join(dataDir, '.env');

  // Ensure data directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Read existing content if file exists
  let existingContent = '';
  if (fs.existsSync(envPath)) {
    existingContent = fs.readFileSync(envPath, 'utf-8');
  }

  // Parse existing config
  const existingConfig: Record<string, string> = {};
  existingContent.split('\n').forEach(line => {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      existingConfig[match[1].trim()] = match[2].trim();
    }
  });

  // Merge with new config
  const mergedConfig = { ...existingConfig, ...config };

  // Write back
  const content = Object.entries(mergedConfig)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  fs.writeFileSync(envPath, content);

  // Reload environment variables
  dotenv.config({ path: envPath, override: true });

  // Also directly update process.env to ensure the changes take effect immediately
  Object.entries(config).forEach(([key, value]) => {
    process.env[key] = value;
  });
}

// Validate environment variables
export function validateEnv(): void {
  const errors: string[] = [];

  // 生产环境检查JWT_SECRET强度（如果设置了的话）
  if (process.env.NODE_ENV === 'production') {
    const jwtSecret = process.env.JWT_SECRET;
    if (jwtSecret && jwtSecret.length < 32) {
      errors.push('JWT_SECRET must be at least 32 characters long');
    }
  }

  // 验证数据库配置
  const dbType = process.env.DB_TYPE || 'sqlite';
  if (dbType === 'mysql' || dbType === 'postgresql') {
    if (!process.env.DB_HOST) {
      errors.push(`DB_HOST is required for ${dbType} database`);
    }
    if (!process.env.DB_PASSWORD) {
      errors.push(`DB_PASSWORD is required for ${dbType} database`);
    }
    if (!process.env.DB_NAME) {
      errors.push(`DB_NAME is required for ${dbType} database`);
    }
  }

  // 如果有错误，抛出异常
  if (errors.length > 0) {
    log.error('Environment Validation Failed', { errors });
    throw new Error(`Environment validation failed: ${errors.join(', ')}`);
  }
}

// Get current database configuration
export function getDbConfig(): {
  type: 'sqlite' | 'mysql' | 'postgresql';
  sqlite: { path: string };
  mysql: { host: string; port: number; database: string; user: string; password: string; ssl: boolean };
  postgresql: { host: string; port: number; database: string; user: string; password: string; ssl: boolean };
} {
  log.info('getDbConfig() called', { dbType: process.env.DB_TYPE || 'not set' });

  // 在获取配置前验证环境变量
  validateEnv();

  const dbType = (process.env.DB_TYPE as 'sqlite' | 'mysql' | 'postgresql') || 'sqlite';
  log.info('Using database type', { dbType });

  return {
    type: dbType,
    sqlite: {
      path: process.env.DB_PATH || resolveDefaultDbPath(),
    },
    mysql: {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306', 10),
      database: process.env.DB_NAME || 'hidns',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      ssl: process.env.DB_SSL === 'true',
    },
    postgresql: {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'hidns',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      ssl: process.env.DB_SSL === 'true',
    },
  };
}

// 求值期自动加载：保证任何依赖 env 的模块（jwt / smtp / 初始化）都能先拿到配置。
// 允许用 HIDNS_SKIP_AUTO_ENV=1 关闭（测试里按需手动控制）。
if (process.env.HIDNS_SKIP_AUTO_ENV !== '1') {
  loadEnv();
}
