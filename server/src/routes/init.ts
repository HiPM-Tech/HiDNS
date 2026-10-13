import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { saveEnvConfig } from '../config/env';
import { UserOperations, SystemOperations, SecretOperations } from '../db/bal/business-adapter';
import { createLogger } from '../lib/logger';
import { isSystemInitialized, refreshSystemState, markInitialized } from '../service/systemState';
import {
  applyDatabaseConfig,
  buildDbConfig,
  getDbInitializationState,
  getDefaultSqlitePath,
  getPublicInitDbConfig,
  initializeSchema,
  isSchemaInitialized,
  saveDatabaseConfig,
} from '../service/systemSetup';

const log = createLogger('HTTP').sub('Route').sub('Init');
const router = Router();

/**
 * 初始化端点限流（§安全规范：请求频率限制）。
 * 初始化端点未鉴权，必须限制频率以降低爆破与资源消耗风险。
 */
const initLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 429, msg: 'Too many setup requests, please try again later.' },
});

router.use(initLimiter);

/**
 * 初始化端点守卫。
 *
 * `/api/init` 按 §路由 347「始终可用」，因此安全性必须由端点自身承担：
 * 系统一旦完成初始化，状态变更类端点（/database、/admin）**永久关闭**。
 * 由于 service/systemState 中的已初始化标记是「粘性」的（数据库故障不会使其回退），
 * 数据库重启或不可达期间初始化入口不会重新打开，从而切断
 * 「数据库故障 → 重配数据库 → 创建管理员」的未授权接管链。
 *
 * 未初始化实例上的首次安装仍需开放这些端点（安装向导依赖），
 * 该固有风险建议后续以「安装令牌」方式收敛。
 */
async function requireInitSurface(req: Request, res: Response, next: () => void): Promise<void> {
  // 以最新探测结果为准，避免使用陈旧状态
  await refreshSystemState();

  if (isSystemInitialized()) {
    log.warn('Setup endpoint blocked: system already initialized', { path: req.path });
    res.status(403).json({ code: 403, msg: 'System already initialized' });
    return;
  }
  next();
}

// Get database configuration for the setup form.
// Only expose this before the system has an initialized user table.
router.get('/db-config', async (_req: Request, res: Response) => {
  try {
    // 该端点仅返回脱敏后的配置（无 host、账号与密码），系统未初始化时允许读取
    const state = await getDbInitializationState();
    if (state === 'initialized') {
      return res.status(403).json({ code: 403, msg: 'System already initialized' });
    }

    res.json({
      code: 0,
      data: getPublicInitDbConfig(),
      msg: 'success',
    });
  } catch (error) {
    log.error('Failed to read database configuration', { error });
    res.status(500).json({
      code: 500,
      msg: error instanceof Error ? error.message : 'Failed to read database configuration',
    });
  }
});

// Check system initialization status
router.get('/status', async (req: Request, res: Response) => {
  try {
    log.debug('Checking system status...');
    const state = await getDbInitializationState();
    const dbReachable = state !== 'unreachable';

    log.debug('Status check result', { state });
    res.json({
      code: 0,
      data: {
        initialized: state === 'initialized',
        dbInitialized: dbReachable,
        hasUsers: state === 'initialized',
        // 必须区分「数据库不可达」与「未初始化」，前端据此决定是否跳转安装向导
        dbReachable,
      },
      msg: 'success',
    });
  } catch (error) {
    log.warn('Status check failed', { error });
    // 探测失败时按最保守结果返回，且明确标记数据库不可达
    res.json({
      code: 0,
      data: {
        initialized: false,
        dbInitialized: false,
        hasUsers: false,
        dbReachable: false,
      },
      msg: 'success',
    });
  }
});

// Test database connection and check for existing data
router.post('/test-db', requireInitSurface, async (req: Request, res: Response) => {
  const { type, sqlite, mysql: mysqlConfig, postgresql: pgConfig } = req.body;

  log.info('Received test-db request', { type, sqlitePath: sqlite?.path });

  if (!type || !['sqlite', 'mysql', 'postgresql'].includes(type)) {
    return res.status(400).json({ code: 400, msg: 'Invalid database type' });
  }

  try {
    if (type === 'sqlite') {
      const sqlitePath = sqlite?.path || './data/hidns.db';
      log.info('Testing SQLite connection', { path: sqlitePath });

      const result = await SystemOperations.testSqliteConnection(sqlitePath);
      log.info('SQLite test result', { result });
      return res.json({
        code: 0,
        data: result,
        msg: 'success'
      });
    }

    if (type === 'mysql') {
      if (!mysqlConfig) {
        return res.status(400).json({ code: 400, msg: 'MySQL configuration required' });
      }

      log.info('Testing MySQL connection', { host: mysqlConfig.host, database: mysqlConfig.database });
      const result = await SystemOperations.testMysqlConnection(mysqlConfig);
      return res.json({
        code: 0,
        data: result,
        msg: 'success'
      });
    }

    if (type === 'postgresql') {
      if (!pgConfig) {
        return res.status(400).json({ code: 400, msg: 'PostgreSQL configuration required' });
      }

      log.info('Testing PostgreSQL connection', { host: pgConfig.host, database: pgConfig.database });
      const result = await SystemOperations.testPostgresqlConnection(pgConfig);
      return res.json({
        code: 0,
        data: result,
        msg: 'success'
      });
    }
  } catch (error) {
    log.error('Test database connection failed', { error, type, sqlitePath: sqlite?.path });
    return res.status(400).json({
      code: 400,
      data: { success: false, message: error instanceof Error ? error.message : 'Connection failed' },
      msg: error instanceof Error ? error.message : 'Connection failed'
    });
  }
});

// Initialize database（状态变更类端点：系统已初始化后永久关闭）
router.post('/database', requireInitSurface, async (req: Request, res: Response) => {
  const { type, sqlite, mysql: mysqlConfig, postgresql: pgConfig, reset = false } = req.body;

  if (!type || !['sqlite', 'mysql', 'postgresql'].includes(type)) {
    return res.status(400).json({ code: 400, msg: 'Invalid database type' });
  }

  // Step 1: Test connection and check for existing data
  const testConfig = buildDbConfig(type, sqlite, mysqlConfig, pgConfig);
  let hasExistingData = false;
  let hasExistingUsers = false;

  try {
    log.info('Testing database connection', { type, sqlitePath: sqlite?.path });
    const testResult = await SystemOperations.testConnection({
      type,
      sqlite: sqlite || { path: getDefaultSqlitePath() },
      mysql: mysqlConfig,
      postgresql: pgConfig,
    });
    hasExistingData = testResult.hasExistingData;
    hasExistingUsers = testResult.hasUsers || false;
    log.info('Test connection result', { hasExistingData, hasExistingUsers, type });
  } catch (error) {
    log.warn('Database connection test failed', { error, type, sqlitePath: sqlite?.path });
    // 继续执行，因为这是新数据库的正常情况
  }

  // Step 2: Handle different scenarios based on existing data

  // Scenario A: Has existing users and keeping data -> Skip to complete
  if (hasExistingData && hasExistingUsers && !reset) {
    try {
      // Save config first
      saveDatabaseConfig(type, sqlite, mysqlConfig, pgConfig);

      // 以显式配置重建连接（服务层封装，路由不直接触碰数据库层）
      await applyDatabaseConfig(testConfig);
      log.info('Connected to existing database with users, skipping to complete');

      return res.json({
        code: 0,
        data: {
          success: true,
          skipToComplete: true,
          message: 'Database already initialized with users. Setup complete.'
        },
        msg: 'Database already initialized with users. Setup complete.',
      });
    } catch (error) {
      log.error('Failed to connect to existing database', { error });
      return res.status(500).json({
        code: 500,
        msg: 'Failed to connect to existing database. Please check your configuration.',
      });
    }
  }

  // Scenario B: Has existing data but no users, keeping data -> Skip to user creation
  if (hasExistingData && !hasExistingUsers && !reset) {
    try {
      // Save config first
      saveDatabaseConfig(type, sqlite, mysqlConfig, pgConfig);

      // 以显式配置重建连接（服务层封装，路由不直接触碰数据库层）
      await applyDatabaseConfig(testConfig);
      log.info('Connected to existing database without users, skipping to user creation');

      return res.json({
        code: 0,
        data: {
          success: true,
          skipToUserCreation: true,
          message: 'Database already initialized. Proceed to create admin user.'
        },
        msg: 'Database already initialized. Please create admin user.',
      });
    } catch (error) {
      log.error('Failed to connect to existing database', { error });
      return res.status(500).json({
        code: 500,
        msg: 'Failed to connect to existing database. Please check your configuration.',
      });
    }
  }

  // Scenario C: Fresh initialization or reset
  try {
    // Save configuration
    saveDatabaseConfig(type, sqlite, mysqlConfig, pgConfig);

    // Clean up temp DB marker (used by app.ts for in-memory pre-init mode)
    delete process.env._TEMP_DB;

    // Generate JWT secret if needed
    const currentJwtSecret = process.env.JWT_SECRET || '';
    if (!currentJwtSecret || currentJwtSecret === 'dnsmgr-secret-key') {
      saveEnvConfig({ JWT_SECRET: crypto.randomBytes(32).toString('hex') });
    }

    // 以显式配置重建连接并初始化 schema（均经由服务层，路由不直接触碰数据库层）
    log.info('Creating new database connection', { type, reset });
    await applyDatabaseConfig(testConfig);

    await initializeSchema();
    log.info(reset
      ? 'Database schema reset successfully via DSM'
      : 'Database schema initialized successfully via DSM');

    return res.json({
      code: 0,
      data: { success: true, reset },
      msg: reset ? 'Database reset successfully' : 'Database initialized successfully',
    });
  } catch (error) {
    log.error('Database initialization error', { error, type, reset });
    return res.status(500).json({
      code: 500,
      msg: error instanceof Error ? error.message : 'Failed to initialize database',
    });
  }
});

// Create admin user（状态变更类端点：系统已初始化后永久关闭，避免被抢先占用管理员账号）
router.post('/admin', requireInitSurface, async (req: Request, res: Response) => {
  try {
    const state = await getDbInitializationState();

    // 数据库不可达时不得创建管理员（此前会被误判为“未初始化”）
    if (state === 'unreachable') {
      return res.status(503).json({ code: 503, msg: 'Database is unreachable. Please check the database and retry.' });
    }

    // 数据库可达但 users 表尚未建立
    if (state === 'uninitialized' && !(await isSchemaInitialized())) {
      return res.status(400).json({ code: 400, msg: 'Database not initialized. Please initialize database first.' });
    }

    // 已有用户则拒绝
    if (state === 'initialized') {
      return res.status(400).json({ code: 400, msg: 'Admin user already exists' });
    }

    const { username, email, password } = req.body;

    // Validate required fields
    if (!username || !email || !password) {
      return res.status(400).json({ code: 400, msg: 'Username, email and password are required' });
    }

    // Validate username format
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({ code: 400, msg: 'Username must be 3-20 characters, alphanumeric and underscore only' });
    }

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ code: 400, msg: 'Invalid email format' });
    }

    // Validate password length
    if (password.length < 6) {
      return res.status(400).json({ code: 400, msg: 'Password must be at least 6 characters' });
    }

    const hash = bcrypt.hashSync(password, 10);

    // 使用业务适配器创建用户，而不是直接调用数据库抽象层
    await UserOperations.create({
      username,
      nickname: username,
      email,
      password_hash: hash,
      role: 'admin',
      role_level: 3,
    });

    // 使用业务适配器轮换运行时密钥
    await SecretOperations.rotateRuntimeSecrets();

    // 初始化完成：立刻把系统标记为已初始化，使初始化入口即时关闭
    markInitialized();

    log.info('Admin user created successfully', { username, email });

    res.json({
      code: 0,
      data: { success: true },
      msg: 'Admin user created successfully',
    });
  } catch (error) {
    log.error('Failed to create admin user', { error });
    res.status(500).json({
      code: 500,
      msg: error instanceof Error ? error.message : 'Failed to create admin user',
    });
  }
});

export default router;
