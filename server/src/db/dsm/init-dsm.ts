import { SchemaReconciler } from './schema-reconciler';
import { COMPLETE_SCHEMA } from './schemas/complete-schema';
import { DataMigrationRunner, DataMigration } from './data-migration-runner';
import { SchemaVersionManager } from './migration-manager';
import { sqliteSchema } from './schemas/generate-sql';
import { getConnection } from '../dal/connection';
import { createLogger } from '../../lib/logger';
import * as fs from 'fs';
import * as path from 'path';

const log = createLogger('DSM').sub('Init');

/** 孤儿域名清理 SQL（顺序敏感：先子表后主表；三库都支持 NOT EXISTS + IN 子查询） */
export const ORPHAN_DOMAIN_CLEANUP_SQL = [
  'DELETE FROM dns_records WHERE domain_id IN (SELECT id FROM domains d WHERE NOT EXISTS (SELECT 1 FROM dns_accounts a WHERE a.id = d.account_id))',
  'DELETE FROM domain_permissions WHERE domain_id IN (SELECT id FROM domains d WHERE NOT EXISTS (SELECT 1 FROM dns_accounts a WHERE a.id = d.account_id))',
  'DELETE FROM failover_status WHERE config_id IN (SELECT id FROM failover_configs WHERE domain_id IN (SELECT id FROM domains d WHERE NOT EXISTS (SELECT 1 FROM dns_accounts a WHERE a.id = d.account_id)))',
  'DELETE FROM failover_configs WHERE domain_id IN (SELECT id FROM domains d WHERE NOT EXISTS (SELECT 1 FROM dns_accounts a WHERE a.id = d.account_id))',
  'DELETE FROM servicemonitor_monitors WHERE domain_id IN (SELECT id FROM domains d WHERE NOT EXISTS (SELECT 1 FROM dns_accounts a WHERE a.id = d.account_id))',
  'DELETE FROM domains WHERE NOT EXISTS (SELECT 1 FROM dns_accounts a WHERE a.id = domains.account_id)',
];

/** 续期表的孤儿行：账号被删、续期记录还在（旧代码只删账号时留下的） */
export const ORPHAN_RENEWABLE_CLEANUP_SQL = [
  'DELETE FROM renewable_domains WHERE NOT EXISTS (SELECT 1 FROM dns_accounts a WHERE a.id = renewable_domains.account_id)',
];

export async function initializeDSM(dryRun = false): Promise<void> {
  const reconciler = new SchemaReconciler();

  try {
    const legacyCheck = await reconciler.detectLegacySystem();
    const isLegacy = legacyCheck.isLegacy;
    if (isLegacy) {
      log.warn( `⚠️ Legacy system detected: ${legacyCheck.reason}`);
      log.info( 'Running in legacy upgrade mode. Performing full reconciliation...');
    } else {
      log.info( 'No legacy system detected. Proceeding with standard DSM initialization.');
    }

    log.info( `Starting full database schema reconciliation${dryRun ? ' (DRY RUN)' : ''}...`);

    await reconciler.reconcile(COMPLETE_SCHEMA, { dryRun });

    if (!dryRun) {
      // 数据迁移**每次启动都跑**：runner 自己按 schema_versions 里已记录的 migration id 做增量，
      // 已执行过的会 skip，所以重复执行是幂等的。
      //
      // 之前只在 isLegacy 时跑，而 detectLegacySystem 查的是 system_type='hidns-dsm'、
      // 写入方记的是 'hidns-migration' —— 判定恒为 true，等于靠不一致的判定在兜底。
      // 一旦有人把判定改对，后续新增的数据迁移（含孤儿数据清理）在存量库上就再也不会执行。
      log.info('Running data migrations...');
      const runner = new DataMigrationRunner();
      registerDefaultMigrations(runner);
      const result = await runner.run({ dryRun });

      if (result.failed.length > 0) {
        log.error('Some migrations failed:', result.failed.map(f => f.id));
      }

      // 唯一约束的 ensure 必须每次启动都跑：
      // 老版本把它挂在一次性迁移里，而那次执行在 MySQL 上被空 catch 吞掉并记为成功，
      // 于是已发布版本跑过的库升级后永远不会补建约束。
      try {
        const ensureConn = getConnection();
        await ensureEmailUniqueness({
          execute: ensureConn.execute.bind(ensureConn),
          query: ensureConn.query.bind(ensureConn),
        });
      } catch (error) {
        log.warn('ensureEmailUniqueness failed', { error: error instanceof Error ? error.message : String(error) });
      }

      log.info( 'Running integrity check...');
      const check = await reconciler.verify(COMPLETE_SCHEMA);

      if (check.valid) {
        log.info( '✅ All schemas are up to date and verified.');
      } else {
        log.error( '❌ Integrity check failed:', check.issues);
        throw new Error(`Schema integrity check failed: ${check.issues.join(', ')}`);
      }

      const conn = getConnection();
      const versionManager = new SchemaVersionManager(conn, sqliteSchema);

      let appVersion = 'unknown';
      try {
        const pkgPath = path.join(__dirname, '../../package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        appVersion = pkg.version || 'dev';
      } catch (e) {
        log.warn( 'Failed to read package.json version');
      }

      await versionManager.recordDSMVersion(appVersion);
      log.info( `✅ DSM version ${appVersion} recorded.`);

      // 强制 WAL checkpoint，确保所有更改写入主数据库文件
      if (conn.checkpoint) {
        await conn.checkpoint();
        log.info( '✅ WAL checkpoint completed after init.');
      }
    } else {
      log.warn( '⚠️ Dry run finished. No changes were made.');
    }
  } catch (error) {
    log.error( '❌ Schema reconciliation failed:', error);
    throw error;
  }
}

function registerDefaultMigrations(runner: DataMigrationRunner): void {
  runner.register({
    id: 'migrate-dns-account-type',
    description: 'Migrate dnsmgr account type to hidns',
    condition: async () => {
      const conn = getConnection();
      const res = await conn.get("SELECT COUNT(*) as cnt FROM dns_accounts WHERE type = 'dnsmgr'");
      return Number((res as any)?.cnt || 0) > 0;
    },
    execute: async () => {
      const conn = getConnection();
      await conn.execute("UPDATE dns_accounts SET type = 'hidns' WHERE type = 'dnsmgr'");
    }
  });

  runner.register({
    id: 'init-security-policies',
    description: 'Initialize default security policies',
    condition: async () => {
      const conn = getConnection();
      const res = await conn.get("SELECT COUNT(*) as cnt FROM security_policies");
      return Number((res as any)?.cnt || 0) === 0;
    },
    execute: async () => {
      const conn = getConnection();
      await conn.execute(`INSERT INTO security_policies
        (require_2fa_global, min_password_length, session_timeout_hours, max_login_attempts)
        VALUES (0, 8, 24, 5)`);
    }
  });

  runner.register({
    id: 'migrate-ns-domain-name',
    description: 'Populate ns_monitor_domains.domain_name from domains table',
    dependsOn: ['init-security-policies'],
    condition: async () => {
      const conn = getConnection();
      const res = await conn.get("SELECT COUNT(*) as cnt FROM ns_monitor_domains WHERE domain_name IS NULL OR domain_name = ''");
      return Number((res as any)?.cnt || 0) > 0;
    },
    execute: async () => {
      const conn = getConnection();
      const type = conn.type;
      if (type === 'mysql' || type === 'postgresql') {
        await conn.execute(`UPDATE ns_monitor_domains nmd SET domain_name = (
          SELECT d.name FROM domains d WHERE d.id = nmd.domain_id
        ) WHERE nmd.domain_name IS NULL OR nmd.domain_name = ''`);
      } else {
        await conn.execute(`UPDATE ns_monitor_domains SET domain_name = (
          SELECT domains.name FROM domains WHERE domains.id = ns_monitor_domains.domain_id
        ) WHERE domain_name IS NULL OR domain_name = ''`);
      }
    }
  });

  runner.register({
    id: 'migrate-domains-whois-fields',
    description: 'Add apex_expires_at and whois_status to domains table',
    dependsOn: ['migrate-ns-domain-name'],
    condition: async () => {
      const conn = getConnection();
      let cols: any[];
      if (conn.type === 'sqlite') {
        cols = await conn.query(`PRAGMA table_info(domains)`);
      } else if (conn.type === 'mysql') {
        cols = await conn.query("SELECT COLUMN_NAME as name FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = (SELECT DATABASE()) AND TABLE_NAME = 'domains'");
      } else {
        cols = await conn.query("SELECT column_name as name FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = current_schema() AND TABLE_NAME = 'domains'");
      }
      return !cols.some((c: any) => c.name.replace(/["'`]/g, '') === 'apex_expires_at');
    },
    execute: async () => {
      const conn = getConnection();
      try { await conn.execute('ALTER TABLE domains ADD COLUMN apex_expires_at DATETIME'); } catch {}
      try { await conn.execute('ALTER TABLE domains ADD COLUMN whois_status TEXT'); } catch {}
    }
  });

  runner.register({
    id: 'migrate-domains-enabled',
    description: 'Add enabled column to domains table',
    dependsOn: ['migrate-domains-whois-fields'],
    condition: async () => {
      const conn = getConnection();
      let cols: any[];
      if (conn.type === 'sqlite') {
        cols = await conn.query(`PRAGMA table_info(domains)`);
      } else if (conn.type === 'mysql') {
        cols = await conn.query("SELECT COLUMN_NAME as name FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = (SELECT DATABASE()) AND TABLE_NAME = 'domains'");
      } else {
        cols = await conn.query("SELECT column_name as name FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = current_schema() AND TABLE_NAME = 'domains'");
      }
      return !cols.some((c: any) => c.name.replace(/["'`]/g, '') === 'enabled');
    },
    execute: async () => {
      const conn = getConnection();
      try { await conn.execute('ALTER TABLE domains ADD COLUMN enabled BOOLEAN DEFAULT 1'); } catch {}
    }
  });

  runner.register({
    id: 'migrate-dns-accounts-enabled-rebuild',
    description: 'Add enabled column to dns_accounts via export-rebuild pattern',
    dependsOn: ['migrate-domains-enabled'],
    condition: async () => {
      const conn = getConnection();
      if (conn.type === 'sqlite') {
        const cols = await conn.query(`PRAGMA table_info(dns_accounts)`);
        return !cols.some((c: any) => c.name.replace(/["'`]/g, '') === 'enabled');
      } else {
        const res = await conn.get("SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'dns_accounts' AND COLUMN_NAME = 'enabled'");
        return Number((res as any)?.cnt || 0) === 0;
      }
    },
    execute: async () => {
      const conn = getConnection();
      const type = conn.type;

      if (type === 'mysql') {
        await conn.execute('DROP TABLE IF EXISTS dns_accounts_new');
        await conn.execute(`CREATE TABLE dns_accounts_new (
          id INT AUTO_INCREMENT PRIMARY KEY, type VARCHAR(100) NOT NULL, name VARCHAR(255) NOT NULL,
          config JSON, remark TEXT, created_by INT NOT NULL, team_id INT DEFAULT NULL,
          enabled TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_created_by (created_by), INDEX idx_team_id (team_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

        await conn.execute(`INSERT INTO dns_accounts_new (id, type, name, config, remark, created_by, team_id, enabled, created_at)
          SELECT id, type, name, config, remark, created_by, team_id, 1, created_at FROM dns_accounts`);

        await conn.execute('SET FOREIGN_KEY_CHECKS = 0');
        await conn.execute('DROP TABLE dns_accounts');
        await conn.execute('ALTER TABLE dns_accounts_new RENAME TO dns_accounts');
        await conn.execute('SET FOREIGN_KEY_CHECKS = 1');
      } else if (type === 'sqlite') {
        await conn.execute('DROP TABLE IF EXISTS dns_accounts_new');
        await conn.execute(`CREATE TABLE dns_accounts_new AS SELECT id, type, name, config, remark, created_by, team_id, 1 as enabled, created_at FROM dns_accounts`);
        await conn.execute('DROP TABLE dns_accounts');
        await conn.execute('ALTER TABLE dns_accounts_new RENAME TO dns_accounts');
      }
    }
  });

  runner.register({
    id: 'migrate-ns-monitor-cleanup',
    description: 'Deduplicate ns_monitor_domains and drop domain_id column',
    dependsOn: ['migrate-ns-domain-name'],
    condition: async () => {
      const conn = getConnection();
      if (conn.type === 'sqlite') {
        const cols = await conn.query(`PRAGMA table_info(ns_monitor_domains)`);
        return cols.some((c: any) => c.name.replace(/["'`]/g, '') === 'domain_id');
      } else {
        const res = await conn.get("SELECT COUNT(*) as cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'ns_monitor_domains' AND COLUMN_NAME = 'domain_id'");
        return Number((res as any)?.cnt || 0) > 0;
      }
    },
    execute: async () => {
      const conn = getConnection();
      const type = conn.type;

      if (type === 'mysql') {
        await conn.execute(`DELETE n1 FROM ns_monitor_domains n1 INNER JOIN ns_monitor_domains n2
          WHERE n1.id > n2.id AND n1.user_id = n2.user_id AND n1.domain_name = n2.domain_name`);
      } else {
        await conn.execute(`DELETE FROM ns_monitor_domains WHERE rowid NOT IN (
          SELECT MIN(rowid) FROM ns_monitor_domains GROUP BY user_id, domain_name
        )`);
      }

      if (type === 'sqlite') {
        await conn.execute('DROP TABLE IF EXISTS ns_monitor_domains_new');
        await conn.execute(`CREATE TABLE ns_monitor_domains_new AS
          SELECT id, user_id, domain_name, expected_ns, current_ns, encrypted_ns, plain_ns,
                 is_poisoned, status, enabled, last_check_at, last_alert_at, alert_count, created_at, updated_at
          FROM ns_monitor_domains`);
        await conn.execute('DROP TABLE ns_monitor_domains');
        await conn.execute('ALTER TABLE ns_monitor_domains_new RENAME TO ns_monitor_domains');
        await conn.execute('CREATE UNIQUE INDEX IF NOT EXISTS unique_user_domain ON ns_monitor_domains(user_id, domain_name)');
      } else {
        try { await conn.execute('ALTER TABLE ns_monitor_domains DROP FOREIGN KEY ns_monitor_domains_ibfk_1'); } catch {}
        await conn.execute('ALTER TABLE ns_monitor_domains DROP COLUMN domain_id');
      }
    }
  });

  runner.register({
    id: 'cleanup-old-ns-tables',
    description: 'Drop deprecated ns_monitor_configs, status, and alerts tables',
    dependsOn: ['migrate-ns-monitor-cleanup'],
    condition: async () => {
      const conn = getConnection();
      let tables: any[];
      if (conn.type === 'sqlite') {
        tables = await conn.query("SELECT name FROM sqlite_master WHERE type='table'");
      } else if (conn.type === 'mysql') {
        tables = await conn.query("SHOW TABLES");
      } else {
        tables = await conn.query("SELECT tablename as name FROM pg_catalog.pg_tables WHERE schemaname = 'public'");
      }
      const names = tables.map((t: any) => t.name || Object.values(t)[0]);
      return names.some((n: string) => ['ns_monitor_configs', 'ns_monitor_status', 'ns_monitor_alerts'].includes(n));
    },
    execute: async () => {
      const conn = getConnection();
      const cascade = conn.type !== 'sqlite' ? ' CASCADE' : '';
      await conn.execute(`DROP TABLE IF EXISTS ns_monitor_configs${cascade}`);
      await conn.execute(`DROP TABLE IF EXISTS ns_monitor_status${cascade}`);
      await conn.execute(`DROP TABLE IF EXISTS ns_monitor_alerts${cascade}`);
    }
  });

  /**
   * 孤儿域名对齐：所属账号已被删除、但域名行还留着的记录。
   *
   * 产生原因：删除账号时只删 dns_accounts 一行，历史库未必真的有
   * `domains.account_id ON DELETE CASCADE` 这条外键，级联不会发生。
   * 这些域名既不能解析也不能被用户删除，只能在这里统一清掉。
   *
   * 之后由删除路由显式清理（见 routes/accounts.ts），本迁移只负责存量。
   */
  runner.register({
    id: 'cleanup-orphan-domains',
    description: 'Remove domains whose account no longer exists (plus their records and permissions)',
    dependsOn: ['cleanup-old-ns-tables'],
    condition: async () => {
      const conn = getConnection();
      try {
        const res = await conn.get(
          'SELECT COUNT(*) as cnt FROM domains d WHERE NOT EXISTS (SELECT 1 FROM dns_accounts a WHERE a.id = d.account_id)',
        );
        return Number((res as any)?.cnt || 0) > 0;
      } catch {
        // 表还不存在（全新库）时直接跳过
        return false;
      }
    },
    execute: async () => {
      const conn = getConnection();
      for (const sql of ORPHAN_DOMAIN_CLEANUP_SQL) {
        await conn.execute(sql);
      }
    }
  });

  /**
   * 续期表孤儿行清理。
   *
   * 上面那条迁移只清 domains 子树；旧代码删账号时（只删 dns_accounts 一行、库又缺 FK）
   * 留下的 renewable_domains 没有任何入口清理。单独一条迁移，让已经记过账的库也能再跑一次。
   */
  /**
   * 邮箱唯一性收敛（issue #43 C0）。
   *
   * 口径：同一邮箱绑多个账号时**保留最早注册的那一个**（id 最小），其余置空并留待用户重新绑定。
   * 空串归一成 NULL —— 否则唯一索引会把所有未填邮箱的用户判成冲突。
   * 每次启动都执行（幂等）：既是清理，也是「补建唯一索引」。
   */
  runner.register({
    id: 'normalize-user-emails',
    description: 'Normalize empty emails, dedupe keeping earliest id, add unique index',
    dependsOn: ['cleanup-orphan-renewables'],
    condition: async () => true,
    execute: async () => {
      const result = await normalizeUserEmails(getConnection());
      if (result.cleared > 0) {
        log.warn('Duplicate user emails cleared (kept earliest id)', { cleared: result.cleared });
      }
    }
  });

  runner.register({
    id: 'cleanup-orphan-renewables',
    description: 'Remove renewable_domains rows whose account no longer exists',
    dependsOn: ['cleanup-orphan-domains'],
    condition: async () => {
      const conn = getConnection();
      try {
        const res = await conn.get(
          'SELECT COUNT(*) as cnt FROM renewable_domains r WHERE NOT EXISTS (SELECT 1 FROM dns_accounts a WHERE a.id = r.account_id)',
        );
        return Number((res as any)?.cnt || 0) > 0;
      } catch {
        return false;
      }
    },
    execute: async () => {
      const conn = getConnection();
      for (const sql of ORPHAN_RENEWABLE_CLEANUP_SQL) {
        await conn.execute(sql);
      }
    }
  });
}

/**
 * 邮箱唯一性收敛（issue #43 C0）。
 *
 * 口径：同一邮箱保留 id 最小的一条，其余置空。
 *
 * 「空」用空串而不是 NULL：SQLite 的 reconciler 不会把已有列的 NOT NULL 改掉，
 * 老库上 UPDATE ... SET email = NULL 会直接失败。空串配合**部分唯一索引**
 * （WHERE email <> ''）达到同样效果；MySQL 不支持部分索引则退化为普通索引 + 应用层校验。
 *
 * 每次启动执行（幂等）：既是清理，也是补建索引。
 */

/**
 * 确保「非空 email 唯一」的数据库约束存在。
 *
 * 幂等：可以每次启动都调用。与 normalizeUserEmails 分开的原因见调用点注释。
 */
export async function ensureEmailUniqueness(conn: {
  execute: (sql: string, params?: unknown[]) => Promise<unknown>;
  query: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
}): Promise<void> {
  // 唯一性约束：空串可以重复（未填邮箱的用户是常态）
  const dialect = (process.env.DB_TYPE || 'sqlite').toLowerCase();
  // 只按 MySQL（Oracle 8.0+）分支：MariaDB 不在支持范围（见 root.ai.md 数据库驱动一节），
  // 不为它单独铺方言分支。
  if (dialect === 'mysql') {
    // 建列前先看存量：ADD COLUMN 要为所有存量行求值，
    // 任一行 email 超过 191 字符即 1406，列与索引都建不出来，且每次启动都会重试失败。
    // 这种情况下宁可不建约束并明确报错，也不要让「约束不存在」变成静默状态。
    try {
      const tooLong = await conn.query<{ n: number }>(
        'SELECT COUNT(*) AS n FROM users WHERE email IS NOT NULL AND CHAR_LENGTH(email) > 191',
      );
      const count = Number((tooLong?.[0] as { n?: number } | undefined)?.n ?? 0);
      if (count > 0) {
        log.error('存在超长邮箱，跳过 MySQL 唯一约束创建', {
          count,
          hint: '这些邮箱超过 191 字符（生成列宽度）。请先清理或改短；新写入已被应用层拦截。',
        });
        return;
      }
    } catch (error) {
      log.warn('检查超长邮箱失败，继续尝试建约束', { error: error instanceof Error ? error.message : String(error) });
    }

    // MySQL/MariaDB 不支持部分索引；MariaDB 连表达式索引也不支持。
    // 用「生成列 + 普通唯一索引」达到等价语义：空串映射为 NULL，唯一索引不收纳 NULL。
    // （issue #62：此前直接把 `CREATE ... WHERE` 发给 MySQL，每次启动刷 ER_PARSE_ERROR 1064）
    try {
      const cols = await conn.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'uk_email'",
      );
      if (!Number((cols?.[0] as { n?: number } | undefined)?.n ?? 0)) {
        await conn.execute(
          // 用 STORED 而不是 PERSISTENT：PERSISTENT 是 MariaDB 的关键字，
          // Oracle MySQL 8 的 ALTER TABLE 语法只接受 VIRTUAL / STORED，写 PERSISTENT 会 1064。
          // STORED 在 MariaDB 10.2+ 与 MySQL 5.7+ 都合法，是两个引擎的交集。
          "ALTER TABLE users ADD COLUMN uk_email VARCHAR(191) GENERATED ALWAYS AS (IF(email IS NULL OR email = '', NULL, email)) STORED",
          // 191 而不是 500：utf8mb4 下 191*4 = 764 字节 < 767，
          // 从 MySQL 5.7 升级上来仍是 COMPACT 行格式的 users 表也能建出唯一索引
          //（500 字符 = 2000 字节，只在 DYNAMIC 的 3072 上限内成立，COMPACT 会 1071）。
        );
      }
      await conn.execute('CREATE UNIQUE INDEX idx_users_email_active ON users(uk_email)');
    } catch (error) {
      // 只有「已存在」可以静默；语法/权限/索引过长（1071）都必须留痕，
      // 否则 MySQL 上会退化成「约束不存在但没人知道」。
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists|Duplicate key name|exists/i.test(message)) {
        log.warn('MySQL email uniqueness constraint setup failed', { error: message });
      }
    }
  } else {
    try {
      await conn.execute("CREATE UNIQUE INDEX idx_users_email ON users(email) WHERE email <> ''");
    } catch {
      /* 已存在 */
    }
  }
}
export async function normalizeUserEmails(conn: {
  execute: (sql: string, params?: unknown[]) => Promise<unknown>;
  query: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
}): Promise<{ cleared: number }> {
  // 旧库可能是 NULL（新 schema 允许），统一成空串
  await conn.execute("UPDATE users SET email = '' WHERE email IS NULL");

  const duplicates = await conn.query<{ email: string; keep_id: number }>(
    "SELECT email, MIN(id) AS keep_id FROM users WHERE email IS NOT NULL AND email <> '' GROUP BY email HAVING COUNT(*) > 1",
  );
  for (const row of duplicates) {
    await conn.execute("UPDATE users SET email = '' WHERE email = ? AND id <> ?", [row.email, row.keep_id]);
  }

  // 唯一性约束的创建已拆成独立函数，见 ensureEmailUniqueness：
  // 它必须每次启动都跑（幂等），不能挂在一次性迁移里——
  // 2.3.10/2.3.11 的旧代码把 MySQL 的 1064 吞进空 catch 并正常返回，
  // 迁移被记为成功，升级后永远不会重试，约束就此永久缺失。
  await ensureEmailUniqueness(conn);
  return { cleared: duplicates.length };
}
