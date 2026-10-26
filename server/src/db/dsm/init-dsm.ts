import { SchemaReconciler } from './schema-reconciler';
import { COMPLETE_SCHEMA } from './schemas/complete-schema';
import { DataMigrationRunner, DataMigration } from './data-migration-runner';
import { SchemaVersionManager } from './migration-manager';
import { sqliteSchema } from './schemas/generate-sql';
import { getConnection } from '../dal/connection';
import { createLogger } from '../../lib/logger';
import { migrateTokenServicePermissions } from '../../service/token-migration';
import * as fs from 'fs';
import * as path from 'path';

const log = createLogger('DSM').sub('Init');

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
      // Data migrations are only needed when upgrading from a legacy system.
      // A brand new database already has the complete schema after reconciliation.
      if (isLegacy) {
        log.info( 'Running data migrations for legacy upgrade...');
        const runner = new DataMigrationRunner();
        registerDefaultMigrations(runner);
        const result = await runner.run({ dryRun });

        if (result.failed.length > 0) {
          log.error( 'Some migrations failed:', result.failed.map(f => f.id));
        }
      } else {
        log.info( 'New database detected. Skipping data migrations.');
      }

      await migrateTokenServicePermissions();

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
}
