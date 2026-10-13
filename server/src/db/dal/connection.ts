/**
 * 数据库连接管理器
 * 使用驱动系统提供统一的数据库访问接口
 */

import type {
  DatabaseType,
  DatabaseConnection,
  Transaction,
  RawConnection,
} from './types';
import type { DatabaseConfig } from './config';
import { getDatabaseConfig, validateConfig } from './config';
import type { DatabaseDriver } from '../dl/types';
import { initDriver, getCurrentDriver, closeDriver, DriverManager } from '../dl';
import { createLogger } from '../../lib/logger';

const log = createLogger('DAL').sub('Connection');
/**
 * 驱动包装器
 * 将 DatabaseDriver 包装为 DatabaseConnection 接口
 */
class DriverConnectionWrapper implements DatabaseConnection {
  private driver: DatabaseDriver;

  constructor(driver: DatabaseDriver) {
    this.driver = driver;
  }

  get type(): DatabaseType {
    return this.driver.type;
  }

  get isConnected(): boolean {
    return this.driver.isConnected;
  }

  async query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.driver.query<T>(sql, params);
  }

  async get<T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined> {
    return this.driver.get<T>(sql, params);
  }

  async execute(sql: string, params?: unknown[]): Promise<void> {
    return this.driver.execute(sql, params);
  }

  async insert(sql: string, params?: unknown[]): Promise<number> {
    return this.driver.insert(sql, params);
  }

  async run(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    return this.driver.run(sql, params);
  }

  async beginTransaction(): Promise<Transaction> {
    return this.driver.beginTransaction();
  }

  raw(): RawConnection {
    return this.driver.raw() as RawConnection;
  }

  async close(): Promise<void> {
    return this.driver.close();
  }

  async checkpoint(): Promise<void> {
    if (this.driver.checkpoint) {
      await this.driver.checkpoint();
    }
  }

  getStats(): import('../dl/types').ConnectionStats {
    return this.driver.stats;
  }

  getIoStats(): { reads: number; writes: number } {
    const driver = this.driver as { ioReads?: number; ioWrites?: number };
    return {
      reads: typeof driver.ioReads === 'number' ? driver.ioReads : 0,
      writes: typeof driver.ioWrites === 'number' ? driver.ioWrites : 0,
    };
  }
}

/** 连接管理器 */
export class ConnectionManager {
  private static instance: ConnectionManager | null = null;
  private connection: DatabaseConnection | null = null;
  private connectionPromise: Promise<DatabaseConnection> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10; // 覆盖数据库重启这类需要数十秒的恢复窗口
  private reconnectDelay = 1000; // 初始重连延迟 1秒（指数退避，封顶 30 秒）
  private static readonly MAX_RECONNECT_DELAY = 30000;
  private isShuttingDown = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  private constructor() {}

  static getInstance(): ConnectionManager {
    if (!ConnectionManager.instance) {
      ConnectionManager.instance = new ConnectionManager();
    }
    return ConnectionManager.instance;
  }

  /**
   * 连接到数据库（带重连机制）
   */
  async connect(config?: DatabaseConfig): Promise<DatabaseConnection> {
    const dbConfig = config || getDatabaseConfig();
    validateConfig(dbConfig);

    // 每次 connect() 都是一次全新的尝试，必须重置计数。
    // 否则某一轮重试耗尽后，后续 connect() 会因 while(count >= max) 恒假而
    // 直接抛错、连一次尝试都不做——这正是“数据库重启后连接态无法复原”的直接原因。
    this.reconnectAttempts = 0;

    // 如果正在关闭，拒绝新连接
    if (this.isShuttingDown) {
      throw new Error('Connection manager is shutting down');
    }

    // 如果已有连接，先检查健康状态
    if (this.connection) {
      const isHealthy = await this.checkHealth();
      if (isHealthy) {
        log.info('Returning existing healthy connection', { type: this.connection.type });
        return this.connection;
      }
      // 连接不健康，尝试重连
      log.warn('Existing connection unhealthy, attempting reconnect');
      await this.disconnect();
    }

    if (this.connectionPromise) {
      log.info('Waiting for existing connection promise');
      return this.connectionPromise;
    }

    this.connectionPromise = this.createConnectionWithRetry(dbConfig);
    try {
      this.connection = await this.connectionPromise;
      this.reconnectAttempts = 0; // 重置重连计数
      this.startHealthCheck();
      return this.connection;
    } catch (error) {
      this.connectionPromise = null;
      throw error;
    }
  }

  /**
   * 创建连接（带重试）
   */
  private async createConnectionWithRetry(config: DatabaseConfig): Promise<DatabaseConnection> {
    while (this.reconnectAttempts < this.maxReconnectAttempts) {
      try {
        log.info(`Creating new ${config.type} connection...`, {
          attempt: this.reconnectAttempts + 1,
          maxAttempts: this.maxReconnectAttempts,
        });

        const driver = await initDriver({
          databaseConfig: config,
          driverConfig: {
            logging: config.logging,
            slowQueryThreshold: config.slowQueryThreshold,
          },
        });

        log.info(`${config.type} driver initialized successfully`);
        return new DriverConnectionWrapper(driver);
      } catch (error) {
        this.reconnectAttempts++;
        log.error(`Connection attempt ${this.reconnectAttempts} failed`, { error });

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          log.error('Max reconnection attempts reached');
          throw error;
        }

        // 指数退避（封顶 30 秒）
        const delay = Math.min(
          this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
          ConnectionManager.MAX_RECONNECT_DELAY
        );
        log.info(`Retrying connection in ${delay}ms...`);
        await this.sleep(delay);
      }
    }

    throw new Error('Failed to establish database connection after max retries');
  }

  /**
   * 检查连接健康状态
   */
  private async checkHealth(): Promise<boolean> {
    // 如果正在关闭，跳过健康检查
    if (this.isShuttingDown) {
      return false;
    }

    if (!this.connection) return false;

    try {
      // 执行简单查询测试连接
      await this.connection.get('SELECT 1');
      return true;
    } catch (error) {
      // 只在非关闭状态下记录警告
      if (!this.isShuttingDown) {
        log.warn('Health check failed', { error });
      }
      return false;
    }
  }

  /**
   * 启动健康检查定时器
   */
  private startHealthCheck(): void {
    // 每30秒检查一次连接健康
    this.healthCheckInterval = setInterval(async () => {
      // 如果正在关闭，停止健康检查
      if (this.isShuttingDown) {
        this.stopHealthCheck();
        return;
      }

      const isHealthy = await this.checkHealth();
      if (!isHealthy && !this.isShuttingDown) {
        log.warn('Health check detected unhealthy connection, attempting reconnect');
        try {
          await this.disconnect();
          await this.connect();
        } catch (error) {
          log.error('Auto-reconnect failed', { error });
        }
      }
    }, 30000);
  }

  /**
   * 停止健康检查
   */
  private stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * 获取当前连接
   */
  getConnection(): DatabaseConnection {
    if (!this.connection) {
      throw new Error('Database connection not initialized. Call connect() first.');
    }
    return this.connection;
  }

  /**
   * 优雅断开连接
   */
  async disconnect(): Promise<void> {
    if (this.isShuttingDown) {
      log.warn('Disconnect already in progress');
      return;
    }

    this.isShuttingDown = true;
    log.info('Gracefully shutting down connection...');

    // 停止健康检查
    this.stopHealthCheck();

    // 等待正在进行的连接完成
    if (this.connectionPromise) {
      log.info('Waiting for pending connection to complete...');
      try {
        await Promise.race([
          this.connectionPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 5000)),
        ]);
      } catch (error) {
        log.warn('Pending connection did not complete in time', { error });
      }
      this.connectionPromise = null;
    }

    // 关闭连接（通过 DriverManager 关闭驱动，避免重复关闭）
    // DriverConnectionWrapper.close() 和 closeDriver() 会操作同一个底层驱动
    // 所以只需要调用 closeDriver() 即可
    this.connection = null;

    // 关闭驱动
    try {
      await closeDriver();
      log.info('Driver closed successfully');
    } catch (error) {
      log.error('Error closing driver', { error });
    }

    this.isShuttingDown = false;
    this.reconnectAttempts = 0;
    // 注意：此处**不得**销毁单例。
    // disconnect() 之后通常紧接 connect()（健康检查重连即如此）；
    // 若在这里置空 ConnectionManager.instance，重连会落在已被遗弃的旧实例上，
    // 而模块级 getConnection() 会拿到一个全新的、未连接的管理器，
    // 导致“重连成功”的日志与实际不可用的连接态并存，连接再也无法复原。
  }

  /**
   * 检查是否已连接
   */
  get isConnected(): boolean {
    return this.connection !== null && this.connection.isConnected;
  }

  /**
   * 在事务中执行操作
   */
  async transaction<T>(fn: (trx: Transaction) => Promise<T>): Promise<T> {
    if (!this.connection) {
      throw new Error('Database connection not initialized. Call connect() first.');
    }

    const trx = await this.connection.beginTransaction();
    try {
      const result = await fn(trx);
      await trx.execute('COMMIT');
      return result;
    } catch (error) {
      await trx.execute('ROLLBACK');
      throw error;
    }
  }

  /**
   * 辅助方法：延迟
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/** 便捷函数：获取连接管理器实例 */
export function getConnectionManager(): ConnectionManager {
  return ConnectionManager.getInstance();
}

/** 便捷函数：连接到数据库 */
export async function connect(config?: DatabaseConfig): Promise<DatabaseConnection> {
  return ConnectionManager.getInstance().connect(config);
}

/** 便捷函数：断开连接 */
export async function disconnect(): Promise<void> {
  return ConnectionManager.getInstance().disconnect();
}

/** 便捷函数：获取当前连接 */
export function getConnection(): DatabaseConnection {
  return ConnectionManager.getInstance().getConnection();
}

/** 便捷函数：在事务中执行 */
export async function transaction<T>(fn: (trx: Transaction) => Promise<T>): Promise<T> {
  return ConnectionManager.getInstance().transaction(fn);
}