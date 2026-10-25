import { getConnection } from '../dal/connection';
import { DatabaseSchema, TableDef, ColumnDef, TriggerDef, ViewDef, ProcedureDef } from './schemas/types/schema';
import { BackupManager } from './backup-manager';
import { createLogger } from '../../lib/logger';

const log = createLogger('DSM').sub('SchemaReconciler');

export type DropTablePolicy = 'never' | 'dry-run-only' | 'safe-only' | 'always';

/**
 * 删表策略默认值。
 *
 * 历史默认 `always`：每次启动都会 DROP 掉 schema 之外的所有表，仅留一行 warn。
 * 同库内的历史表、外部工具表、误建表都会被静默清除，属不可逆数据损失。
 * 现改为默认 `never`，需要清理时用 `HIDNS_DSM_DROP_TABLES=always|safe-only|dry-run-only` 显式开启。
 */
function resolveDropTablePolicy(): DropTablePolicy {
  const raw = (process.env.HIDNS_DSM_DROP_TABLES || '').trim().toLowerCase();
  if (raw === 'always' || raw === 'safe-only' || raw === 'dry-run-only' || raw === 'never') {
    return raw;
  }
  return 'never';
}

export interface ReconcileOptions {
  dryRun?: boolean;
  dropTablePolicy?: DropTablePolicy;
  forceBackup?: boolean;
}

export class SchemaReconciler {
  private conn: any;
  private backupManager: BackupManager;

  constructor() {
    this.conn = getConnection();
    this.backupManager = new BackupManager();
  }

  async detectLegacySystem(): Promise<{ isLegacy: boolean; reason?: string }> {
    const versionTableExists = await this.tableExists('schema_versions');
    if (!versionTableExists) {
      const hasDomains = await this.tableExists('domains');
      const hasDnsAccounts = await this.tableExists('dns_accounts');
      const hasSystemConfigs = await this.tableExists('system_configs');
      if (hasDomains || hasDnsAccounts || hasSystemConfigs) {
        return { isLegacy: true, reason: 'No schema_versions table found, but core tables exist.' };
      }
      return { isLegacy: false };
    }

    const result = await this.conn.get(
      "SELECT COUNT(*) as cnt FROM schema_versions WHERE system_type = 'hidns-dsm' AND success = 1"
    );
    const hasDSMRecord = Number((result as any)?.cnt || 0) > 0;

    if (!hasDSMRecord) {
      return { isLegacy: true, reason: 'schema_versions exists but no HiDNS-DSM records found.' };
    }

    return { isLegacy: false };
  }

  async auditSchema(targetSchema: DatabaseSchema): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];
    const existingTables = await this.getAllTables();

    for (const table of targetSchema.tables) {
      if (!existingTables.includes(table.name)) {
        issues.push(`Table missing in database: ${table.name}`);
      } else {
        const dbCols = await this.getTableColumns(table.name);
        const dbColNames = new Set(dbCols.map((c: any) => c.name.replace(/["'`]/g, '')));
        for (const col of table.columns) {
          if (!dbColNames.has(col.name)) {
            issues.push(`Column missing in ${table.name}: ${col.name}`);
          }
        }
      }
    }

    const targetTableNames = new Set(targetSchema.tables.map(t => t.name));
    for (const tableName of existingTables) {
      if (!tableName.startsWith('sqlite_') && !targetTableNames.has(tableName)) {
        issues.push(`Ghost table found in database (not in schema): ${tableName}`);
      }
    }

    return { valid: issues.length === 0, issues };
  }

  /**
   * Pre-check if any schema changes are needed. Returns true if backup should be created.
   * Checks: missing/extra tables, missing/extra columns, missing indexes, ghost tables.
   */
  private async detectChangesNeeded(schema: DatabaseSchema): Promise<boolean> {
    const targetTableNames = new Set(schema.tables.map(t => t.name.toLowerCase()));

    // Check missing tables/columns/indexes (via verify)
    const check = await this.verify(schema);
    if (check.issues.length > 0) return true;

    // Check ghost tables (tables in DB but not in target schema)
    const existingTables = await this.getAllTables();
    const systemTables = new Set(['schema_versions', 'sqlite_sequence']);
    for (const tableName of existingTables) {
      const lower = tableName.toLowerCase();
      if (systemTables.has(lower)) continue;
      if (tableName.startsWith('sqlite_')) continue;
      if (!targetTableNames.has(lower)) {
        // Ghost table exists — may be dropped depending on policy, always trigger backup
        return true;
      }
    }

    // Check extra columns and column type mismatches
    for (const tableDef of schema.tables) {
      const exists = await this.tableExists(tableDef.name);
      if (!exists) return true; // already caught by verify, but just in case

      const dbCols = await this.getTableColumns(tableDef.name);
      const dbColMap = new Map(dbCols.map((c: any) => [c.name.replace(/["'`]/g, ''), c]));
      const targetColNames = new Set(tableDef.columns.map(c => c.name));

      // Extra columns in DB not in target schema
      for (const [colName, colInfo] of dbColMap) {
        if (!targetColNames.has(colName)) {
          return true; // extra column needs to be dropped
        }
      }

      // Column type mismatches (compare actual DB types)
      for (const col of tableDef.columns) {
        const dbCol = dbColMap.get(col.name);
        if (!dbCol) return true; // already caught by verify

        if (col.type === 'id') {
          // Skip id type checking — SERIAL/INTEGER mapping varies by DB
          continue;
        }

        // Simple type mismatch check
        const targetSqlType = this.mapTypeToSQL(col.type, this.getDbType(), col.length);

        // Include character_maximum_length in actual DB type for accurate comparison
        let actualDbType = (dbCol.type || dbCol.data_type || '').toUpperCase();
        if (dbCol.length != null && actualDbType) {
          actualDbType = `${actualDbType}(${dbCol.length})`;
        }

        // Normalize and compare
        if (targetSqlType && actualDbType) {
          const normalizedTarget = targetSqlType.replace(/\(.*?\)/g, '').trim().toUpperCase();
          const normalizedActual = actualDbType.replace(/\(.*?\)/g, '').trim().toUpperCase();

          const compatibleTypes = new Map<string, string[]>([
            ['INTEGER', ['INTEGER', 'INT', 'INT4', 'INT2', 'TINYINT', 'SMALLINT', 'BIGINT', 'SERIAL', 'BIGSERIAL']],
            ['BIGINT', ['BIGINT', 'BIGSERIAL', 'INTEGER', 'INT', 'INT4', 'INT8']],
            ['BOOLEAN', ['BOOLEAN', 'BOOL', 'TINYINT', 'BIT']],
            ['TEXT', ['TEXT', 'VARCHAR', 'CHAR', 'CLOB', 'LONGTEXT', 'MEDIUMTEXT']],
            ['TIMESTAMP', ['TIMESTAMP', 'TIMESTAMPTZ', 'DATETIME']],
            ['DATETIME', ['DATETIME', 'TIMESTAMP', 'TIMESTAMPTZ']],
          ]);

          const isCompatible = compatibleTypes.get(normalizedTarget)?.includes(normalizedActual)
            || normalizedTarget === normalizedActual;

          if (!isCompatible) {
            return true; // type mismatch detected
          }

          // Also detect length changes (e.g. VARCHAR(50) -> VARCHAR(500))
          // Only when both types have explicit length parameters
          const extractLen = (t: string): number | null => {
            const m = t.match(/\((\d+)\)/);
            return m ? parseInt(m[1], 10) : null;
          };
          const targetLen = extractLen(targetSqlType);
          const actualLen = extractLen(actualDbType);
          if (targetLen !== null && actualLen !== null && targetLen !== actualLen) {
            return true; // length changed
          }
        }
      }
    }

    return false;
  }

  private async getAllTables(): Promise<string[]> {
    const type = this.conn.type;
    if (type === 'sqlite') {
      const rows = await this.conn.query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`);
      return rows.map((r: any) => r.name);
    } else if (type === 'mysql') {
      const rows = await this.conn.query("SELECT TABLE_NAME as name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
      return rows.map((r: any) => r.name);
    } else if (type === 'postgresql') {
      const rows = await this.conn.query("SELECT tablename as name FROM pg_tables WHERE schemaname = 'public'");
      return rows.map((r: any) => r.name);
    }
    return [];
  }

  private async tableExists(tableName: string): Promise<boolean> {
    const type = this.conn.type;
    if (type === 'sqlite') {
      const res = await this.conn.get(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [tableName]);
      return !!res;
    } else if (type === 'mysql') {
      const res = await this.conn.get("SELECT TABLE_NAME as name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [tableName]);
      return !!res;
    } else if (type === 'postgresql') {
      const res = await this.conn.get("SELECT tablename as name FROM pg_tables WHERE schemaname = 'public' AND tablename = ?", [tableName]);
      return !!res;
    }
    return false;
  }

  private async getTableColumns(tableName: string): Promise<any[]> {
    const type = this.conn.type;
    if (type === 'sqlite') {
      return this.conn.query(`PRAGMA table_info(${tableName})`);
    } else if (type === 'mysql') {
      return this.conn.query(
        `SELECT COLUMN_NAME as name, DATA_TYPE as type, IS_NULLABLE as nullable, COLUMN_DEFAULT as defaultValue,
                CHARACTER_MAXIMUM_LENGTH as length
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
        [tableName]
      );
    } else if (type === 'postgresql') {
      return this.conn.query(
        `SELECT column_name as name, data_type as type, is_nullable as nullable, column_default as defaultValue,
                character_maximum_length as length
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [tableName]
      );
    }
    return [];
  }

  private async addColumn(table: string, column: string, definition: string): Promise<void> {
    await this.conn.execute(`ALTER TABLE ${this.escapeIdentifier(table)} ADD COLUMN ${definition}`);
  }

  private async dropColumn(table: string, column: string): Promise<void> {
    const dbType = this.getDbType();
    if (dbType === 'sqlite') {
      log.warn( `Using table rebuild for SQLite DROP COLUMN: ${table}.${column}`);
      return;
    }
    await this.conn.execute(`ALTER TABLE ${this.escapeIdentifier(table)} DROP COLUMN ${this.escapeIdentifier(column)}`);
  }

  private async modifyColumnType(table: string, column: string, newType: string, originCol?: ColumnDef, actualDbType?: string): Promise<void> {
    const dbType = this.getDbType();
    if (dbType === 'sqlite') {
      log.warn( `Using table rebuild for SQLite type modification: ${table}.${column}`);
      return;
    }

    if (dbType === 'postgresql' && newType === 'SERIAL') {
      log.warn( `Skipping type modification to SERIAL for ${table}.${column} (SERIAL is a pseudo-type)`);
      return;
    }

    if (dbType === 'postgresql') {
      try {
        await this.conn.execute(`ALTER TABLE ${this.escapeIdentifier(table)} ALTER COLUMN ${this.escapeIdentifier(column)} DROP DEFAULT`);

        let sql = `ALTER TABLE ${this.escapeIdentifier(table)} ALTER COLUMN ${this.escapeIdentifier(column)} TYPE ${newType}`;

        if (newType === 'BOOLEAN' || newType === 'BIGINT' || newType === 'TIMESTAMPTZ' || newType === 'INTEGER') {
          if (newType === 'BOOLEAN' && actualDbType && ['SMALLINT', 'INT', 'INTEGER', 'INT2', 'INT4', 'TINYINT'].includes(actualDbType.toUpperCase().replace(/\(.*?\)/g, '').trim())) {
            sql += ` USING CASE WHEN ${this.escapeIdentifier(column)} != 0 THEN true ELSE false END`;
          } else if (newType === 'TIMESTAMPTZ' && actualDbType && actualDbType.toUpperCase().includes('TIMESTAMP WITHOUT TIME ZONE')) {
            sql += ` USING ${this.escapeIdentifier(column)}::TIMESTAMP WITHOUT TIME ZONE AT TIME ZONE 'UTC'`;
          } else if (newType === 'INTEGER' && actualDbType && actualDbType.toUpperCase() === 'BOOLEAN') {
            sql += ` USING CASE WHEN ${this.escapeIdentifier(column)} THEN 1 ELSE 0 END`;
          } else {
            sql += ` USING ${this.escapeIdentifier(column)}::${newType}`;
          }
        }

        await this.conn.execute(sql);

        if (originCol?.defaultValue !== undefined) {
          const defaultVal = this.formatDefaultValue(originCol.defaultValue, originCol.type, 'postgresql');
          await this.conn.execute(`ALTER TABLE ${this.escapeIdentifier(table)} ALTER COLUMN ${this.escapeIdentifier(column)} SET DEFAULT ${defaultVal}`);
        }
      } catch (pgErr: any) {
        // Generic fallback: if target type has a length limit (e.g. VARCHAR(50)),
        // retry with SUBSTRING to truncate existing data. Works for any data
        // compatibility issue without needing error-code-specific checks.
        const lengthMatch = newType.match(/\((\d+)\)/);
        if (lengthMatch) {
          const length = parseInt(lengthMatch[1], 10);
          log.warn( `Cannot modify type for ${table}.${column} (${pgErr.code || 'unknown'}). Retrying with data truncation (max ${length} chars).`);
          try {
            await this.conn.execute(`ALTER TABLE ${this.escapeIdentifier(table)} ALTER COLUMN ${this.escapeIdentifier(column)} TYPE ${newType} USING SUBSTRING(${this.escapeIdentifier(column)} FROM 1 FOR ${length})`);
            if (originCol?.defaultValue !== undefined) {
              const defaultVal = this.formatDefaultValue(originCol.defaultValue, originCol.type, 'postgresql');
              await this.conn.execute(`ALTER TABLE ${this.escapeIdentifier(table)} ALTER COLUMN ${this.escapeIdentifier(column)} SET DEFAULT ${defaultVal}`);
            }
            return;
          } catch {
            log.warn( `Data truncation fallback also failed for ${table}.${column}. Skipping this column modification.`);
            return;
          }
        }
        throw pgErr;
      }
    } else if (dbType === 'mysql') {
      try {
        if (originCol) {
          const fullDef = this.getColumnDefinitionSQL(originCol);
          const cleanedDef = originCol.primaryKey
            ? fullDef.replace(/\s+PRIMARY KEY\s*/i, ' ').trim()
            : fullDef
                .replace(/\s+PRIMARY KEY\s*/i, ' ')
                .replace(/\s+AUTO_INCREMENT\s*/i, ' ')
                .replace(/\s+AUTOINCREMENT\s*/i, ' ')
                .trim();
          await this.conn.execute('SET FOREIGN_KEY_CHECKS = 0');
          await this.conn.execute(`ALTER TABLE ${this.escapeIdentifier(table)} MODIFY COLUMN ${cleanedDef}`);
          await this.conn.execute('SET FOREIGN_KEY_CHECKS = 1');
        } else {
          await this.conn.execute('SET FOREIGN_KEY_CHECKS = 0');
          await this.conn.execute(`ALTER TABLE ${this.escapeIdentifier(table)} MODIFY COLUMN ${this.escapeIdentifier(column)} ${newType}`);
          await this.conn.execute('SET FOREIGN_KEY_CHECKS = 1');
        }
      } catch (e: any) {
        try { await this.conn.execute('SET FOREIGN_KEY_CHECKS = 1'); } catch {}

        // Generic fallback: if target type has a length limit (e.g. VARCHAR(50)),
        // retry by truncating existing data with SUBSTRING first, then MODIFY COLUMN.
        // Works for any data compatibility issue without needing error-code-specific checks.
        const lengthMatch = newType.match(/\((\d+)\)/);
        if (lengthMatch) {
          const length = parseInt(lengthMatch[1], 10);
          log.warn( `Cannot modify type for ${table}.${column}. Retrying with data truncation (max ${length} chars).`);
          try {
            await this.conn.execute(
              `UPDATE ${this.escapeIdentifier(table)} SET ${this.escapeIdentifier(column)} = SUBSTRING(${this.escapeIdentifier(column)}, 1, ${length})`
            );
            if (originCol) {
              const fullDef = this.getColumnDefinitionSQL(originCol);
              const cleanedDef = originCol.primaryKey
                ? fullDef.replace(/\s+PRIMARY KEY\s*/i, ' ').trim()
                : fullDef
                    .replace(/\s+PRIMARY KEY\s*/i, ' ')
                    .replace(/\s+AUTO_INCREMENT\s*/i, ' ')
                    .replace(/\s+AUTOINCREMENT\s*/i, ' ')
                    .trim();
              await this.conn.execute('SET FOREIGN_KEY_CHECKS = 0');
              await this.conn.execute(`ALTER TABLE ${this.escapeIdentifier(table)} MODIFY COLUMN ${cleanedDef}`);
              await this.conn.execute('SET FOREIGN_KEY_CHECKS = 1');
            } else {
              await this.conn.execute('SET FOREIGN_KEY_CHECKS = 0');
              await this.conn.execute(`ALTER TABLE ${this.escapeIdentifier(table)} MODIFY COLUMN ${this.escapeIdentifier(column)} ${newType}`);
              await this.conn.execute('SET FOREIGN_KEY_CHECKS = 1');
            }
            return;
          } catch {
            log.warn( `Data truncation fallback also failed for ${table}.${column}. Skipping this column modification.`);
            return;
          }
        }
        throw e;
      }
    }
  }

  private isTypeCompatible(actual: string, expected: string): boolean {
    const normalize = (t: string) => t.toUpperCase().replace(/\(.*?\)/g, '').trim();
    const normActual = normalize(actual);
    const normExpected = normalize(expected);

    // Extract length params if present (e.g. VARCHAR(50) -> 50)
    const extractLen = (t: string): number | null => {
      const m = t.match(/\((\d+)\)/);
      return m ? parseInt(m[1], 10) : null;
    };
    const actualLen = extractLen(actual);
    const expectedLen = extractLen(expected);

    // If base types match, check length compatibility
    if (normActual === normExpected) {
      // Both have explicit length — only compatible if they match exactly
      if (actualLen !== null && expectedLen !== null) {
        return actualLen === expectedLen;
      }
      // Neither has length, or one does but the other doesn't — treat as compatible
      // (e.g. TEXT vs TEXT, or CHARACTER VARYING vs VARCHAR(500) where DB doesn't report length)
      return true;
    }

    const aliases: Record<string, string[]> = {
      'VARCHAR': ['CHARACTER VARYING'],
      'CHAR': ['CHARACTER', 'NCHAR'],
      'BOOLEAN': ['BOOL'],
      'INTEGER': ['INT', 'INT4'],
      'BIGINT': ['INT8'],
      'SMALLINT': ['INT2'],
      'TIMESTAMPTZ': ['TIMESTAMP WITH TIME ZONE', 'TIMESTAMP(6) WITH TIME ZONE'],
      'TIMESTAMP': ['TIMESTAMP WITHOUT TIME ZONE', 'DATETIME'],
      'DOUBLE PRECISION': ['FLOAT8', 'FLOAT'],
      'REAL': ['FLOAT4'],
      'NUMERIC': ['DECIMAL', 'NUMBER'],
      'TINYINT(1)': ['BOOLEAN', 'BOOL'],
      'TEXT': ['CLOB'],
    };

    const expectedAliases = aliases[normExpected];
    if (expectedAliases && expectedAliases.includes(normActual)) {
      // Alias matches — check length compatibility if both have explicit length
      if (actualLen !== null && expectedLen !== null) return actualLen === expectedLen;
      return true;
    }

    for (const [canonical, aliasList] of Object.entries(aliases)) {
      if (aliasList.includes(normActual) && canonical === normExpected) {
        // Alias matches — check length compatibility if both have explicit length
        if (actualLen !== null && expectedLen !== null) return actualLen === expectedLen;
        return true;
      }
    }

    return false;
  }

  private async execute(sql: string): Promise<void> {
    await this.conn.execute(sql);
  }

  private escapeIdentifier(name: string): string {
    const dbType = this.getDbType();
    if (dbType === 'mysql') return `\`${name}\``;
    return `"${name}"`;
  }

  private getDbType(): string {
    return this.conn.type;
  }

  async reconcile(schema: DatabaseSchema, options: ReconcileOptions = {}): Promise<void> {
    const { dryRun = false, dropTablePolicy = resolveDropTablePolicy(), forceBackup = true } = options;
    const dbType = this.getDbType();
    log.info( `Starting reconciliation for ${dbType} (Version: ${schema.version})...`);

    if (options.dryRun) {
      log.warn( 'DRY RUN MODE: No changes will be applied to the database.');
    }

    // Only create backup if schema changes are actually needed
    // Brand new databases (no schema_versions table) have no data to protect
    if (!options.dryRun && options.forceBackup !== false) {
      const isExistingDb = await this.tableExists('schema_versions');
      if (isExistingDb) {
        const needsBackup = await this.detectChangesNeeded(schema);
        if (needsBackup) {
          log.info( 'Schema changes detected. Creating backup before applying changes...');
          try {
            await this.backupManager.createBackup(dbType);
            this.backupManager.cleanup(7); // keep backups for 7 days
          } catch (err) {
            log.error( 'Backup failed! Aborting reconciliation to protect data.', err);
            const continueOnFail = process.env.DSM_BACKUP_REQUIRED !== 'true';
            if (continueOnFail) {
              log.warn( 'DSM_BACKUP_REQUIRED is not set to true, continuing with reconciliation...');
            } else {
              throw err;
            }
          }
        } else {
          log.info( 'No schema changes detected. Skipping backup.');
        }
      } else {
        log.info( 'New database. Skipping backup pre-check.');
      }
    }

    // 删表永远先于建表/改列执行；policy 为 never 时只报告不删除
    await this.syncTablesDeletion(schema.tables, dryRun, dropTablePolicy);

    for (const tableDef of schema.tables) {
      await this.syncTable(tableDef, options.dryRun || false);
    }

    // Second pass: ensure all foreign key constraints are properly recreated.
    // During syncTable, referring FKs from other tables may have been dropped
    // to allow column type modifications (e.g., MySQL requires dropping FKs
    // before altering columns they reference). This second pass guarantees
    // all FKs are in place regardless of table processing order.
    if (dbType === 'mysql' || dbType === 'postgresql') {
      for (const tableDef of schema.tables) {
        await this.syncForeignKeys(tableDef, options.dryRun || false);
      }
    }

    if (schema.triggers) {
      for (const trigger of schema.triggers) {
        await this.syncTrigger(trigger, options.dryRun || false);
      }
    }

    if (schema.views) {
      for (const view of schema.views) {
        await this.syncView(view, options.dryRun || false);
      }
    }

    if (schema.procedures) {
      for (const proc of schema.procedures) {
        await this.syncProcedure(proc, options.dryRun || false);
      }
    }

    log.info( 'Reconciliation completed successfully.');
  }

  async verify(schema: DatabaseSchema): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];

    for (const tableDef of schema.tables) {
      const exists = await this.tableExists(tableDef.name);
      if (!exists) {
        issues.push(`Missing table: ${tableDef.name}`);
        continue;
      }

      const existingCols = await this.getTableColumns(tableDef.name);
      const existingNames = new Set(existingCols.map((c: any) => c.name.replace(/["'`]/g, '')));

      for (const col of tableDef.columns) {
        if (!existingNames.has(col.name)) {
          issues.push(`Missing column: ${tableDef.name}.${col.name}`);
        }
      }

      if (tableDef.indexes) {
        for (const idx of tableDef.indexes) {
          if (!(await this.indexExists(idx.name))) {
            issues.push(`Missing index: ${idx.name}`);
          }
        }
      }
    }

    return { valid: issues.length === 0, issues };
  }

  private async syncTable(tableDef: TableDef, dryRun: boolean): Promise<void> {
    const exists = await this.tableExists(tableDef.name);

    if (!exists) {
      const sql = this.generateCreateTableSQL(tableDef);
      if (dryRun) {
        log.sub('DRY RUN').info( `Would create table: ${tableDef.name}`);
        log.sub('DRY RUN').info( `SQL: ${sql}`);
      } else {
        log.info( `Creating new table: ${tableDef.name}`);
        await this.execute(sql);
      }
      // Indexes are not included in CREATE TABLE; create them separately
      await this.syncIndexes(tableDef, dryRun);
      if (this.getDbType() !== 'sqlite') {
        await this.syncForeignKeys(tableDef, dryRun);
      }
    } else {
      log.debug( `Table ${tableDef.name} exists, checking columns and indexes...`);
      if (this.getDbType() === 'mysql') {
        await this.dropAllForeignKeys(tableDef.name);
      }
      await this.syncColumns(tableDef, dryRun);
      await this.syncIndexes(tableDef, dryRun);
      if (this.getDbType() !== 'sqlite') {
        await this.syncForeignKeys(tableDef, dryRun);
      }
    }
  }

  private async syncTablesDeletion(targetTables: TableDef[], dryRun: boolean, policy: DropTablePolicy): Promise<void> {
    const dbType = this.getDbType();
    const targetNames = new Set(targetTables.map(t => t.name.toLowerCase()));

    let existingTables: string[] = [];
    if (dbType === 'sqlite') {
      const rows = await this.conn.query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`);
      existingTables = rows.map((r: any) => r.name.toLowerCase());
    } else if (dbType === 'mysql') {
      const rows = await this.conn.query("SELECT TABLE_NAME as name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
      existingTables = rows.map((r: any) => r.name.toLowerCase());
    } else if (dbType === 'postgresql') {
      const rows = await this.conn.query("SELECT tablename as name FROM pg_tables WHERE schemaname = 'public'");
      existingTables = rows.map((r: any) => r.name.toLowerCase());
    }

    for (const tableName of existingTables) {
      if (!targetNames.has(tableName)) {
        if (tableName.startsWith('sqlite_') || tableName === 'schema_versions') {
          continue;
        }

        if (policy === 'never') {
          log.warn( 'Obsolete table retained (policy: never). Set HIDNS_DSM_DROP_TABLES=safe-only to clean up.', { table: tableName });
          continue;
        }

        if (policy === 'dry-run-only') {
          log.sub('DRY RUN').warn( `Would drop table (policy: dry-run-only): ${tableName}`);
          continue;
        }

        if (policy === 'safe-only') {
          const countRes = await this.conn.get(`SELECT COUNT(*) as cnt FROM ${this.escapeIdentifier(tableName)}`);
          const rowCount = (countRes as any)?.cnt || 0;
          if (rowCount > 0) {
            log.warn( `Skipping non-empty table (policy: safe-only): ${tableName} (${rowCount} rows)`);
            continue;
          }
        }

        if (dryRun) {
          log.sub('DRY RUN').warn( `Would drop table: ${tableName}`);
        } else {
          log.warn( `Dropping obsolete table (policy: ${policy}): ${tableName}`);
          await this.dropTable(tableName);
        }
      }
    }
  }

  private async dropTable(tableName: string): Promise<void> {
    const dbType = this.getDbType();
    // For MySQL and PostgreSQL, we need to drop FK constraints that reference
    // this table before dropping it, otherwise the DROP TABLE will fail with
    // ER_FK_CANNOT_DROP_PARENT (MySQL) or 2BP01 (PostgreSQL).
    if (dbType === 'mysql' || dbType === 'postgresql') {
      await this.dropAllForeignKeys(tableName);
    }
    await this.conn.execute(`DROP TABLE IF EXISTS ${this.escapeIdentifier(tableName)}`);
  }

  private async syncForeignKeys(tableDef: TableDef, dryRun: boolean): Promise<void> {
    const dbType = this.getDbType();
    if (!tableDef.foreignKeys || dbType === 'sqlite') return;

    const existingFKs = await this.getTableForeignKeys(tableDef.name);
    const existingFKNames = new Set(existingFKs.map((fk: any) => fk.constraint_name));

    const targetFKNames = new Set<string>();

    for (const fk of tableDef.foreignKeys) {
      const constraintName = `fk_${tableDef.name}_${fk.column}`;
      targetFKNames.add(constraintName);

      if (!existingFKNames.has(constraintName)) {
        let sql = '';
        if (dbType === 'mysql' || dbType === 'postgresql') {
          sql = `ALTER TABLE ${this.escapeIdentifier(tableDef.name)} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${fk.column}) REFERENCES ${fk.refTable}(${fk.refColumn}) ON DELETE ${fk.onDelete || 'NO ACTION'}`;
        }

        if (sql) {
          if (dryRun) {
            log.sub('DRY RUN').info( `Would add FK: ${constraintName}`);
          } else {
            try {
              await this.execute(sql);
              log.info( `Added foreign key constraint: ${constraintName}`);
            } catch (e: any) {
              if (e.message?.includes('Duplicate key') || e.message?.includes('already exists')) {
                log.debug( `FK ${constraintName} already exists.`);
              } else {
                log.warn( `Failed to add FK ${constraintName}:`, e);
              }
            }
          }
        }
      } else {
        log.debug( `FK ${constraintName} already exists, skipping.`);
      }
    }

    for (const existingFKName of existingFKNames) {
      if (!targetFKNames.has(existingFKName)) {
        if (dryRun) {
          log.sub('DRY RUN').warn( `Would drop FK: ${existingFKName}`);
        } else {
          log.warn( `Dropping obsolete FK: ${existingFKName}`);
          await this.dropForeignKey(tableDef.name, existingFKName);
        }
      }
    }
  }

  private async getTableForeignKeys(tableName: string): Promise<any[]> {
    const dbType = this.getDbType();
    if (dbType === 'mysql') {
      return this.conn.query(
        `SELECT CONSTRAINT_NAME as constraint_name, COLUMN_NAME as column_name,
         REFERENCED_TABLE_NAME as ref_table, REFERENCED_COLUMN_NAME as ref_column
         FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [tableName]
      );
    } else if (dbType === 'postgresql') {
      return this.conn.query(
        `SELECT tc.constraint_name, kcu.column_name,
         ccu.table_name AS ref_table, ccu.column_name AS ref_column,
         rc.delete_rule
         FROM information_schema.table_constraints AS tc
         JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name
         JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name
         JOIN information_schema.referential_constraints AS rc ON rc.constraint_name = tc.constraint_name
         WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1`,
        [tableName]
      );
    }
    return [];
  }

  private async dropForeignKey(tableName: string, constraintName: string): Promise<void> {
    const dbType = this.getDbType();
    if (dbType === 'mysql') {
      try {
        await this.conn.execute(`ALTER TABLE ${this.escapeIdentifier(tableName)} DROP FOREIGN KEY ${this.escapeIdentifier(constraintName)}`);
      } catch (err) {
        log.debug( `FK ${constraintName} not found or already dropped`);
      }
    } else if (dbType === 'postgresql') {
      await this.conn.execute(`ALTER TABLE ${this.escapeIdentifier(tableName)} DROP CONSTRAINT IF EXISTS ${this.escapeIdentifier(constraintName)}`);
    }
  }

  private async getReferencingForeignKeys(tableName: string): Promise<any[]> {
    const dbType = this.getDbType();
    if (dbType === 'mysql') {
      return this.conn.query(
        `SELECT CONSTRAINT_NAME as constraint_name, TABLE_NAME as table_name, COLUMN_NAME as column_name
         FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = ? AND REFERENCED_COLUMN_NAME IS NOT NULL`,
        [tableName]
      );
    } else if (dbType === 'postgresql') {
      return this.conn.query(
        `SELECT tc.constraint_name, tc.table_name, kcu.column_name
         FROM information_schema.table_constraints AS tc
         JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name
         JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name
         WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = $1`,
        [tableName]
      );
    }
    return [];
  }

  private async dropAllForeignKeys(tableName: string): Promise<void> {
    const dbType = this.getDbType();

    // Drop FKs defined on this table
    const fks = await this.getTableForeignKeys(tableName);
    for (const fk of fks) {
      await this.dropForeignKey(tableName, fk.constraint_name || fk.constraintName);
    }

    // Also drop FKs from other tables that reference this table
    // This is necessary for MySQL column type changes, where existing FK constraints
    // referencing the column being modified will block ALTER TABLE MODIFY COLUMN
    if (dbType === 'mysql' || dbType === 'postgresql') {
      const refFks = await this.getReferencingForeignKeys(tableName);
      const seen = new Set<string>();
      for (const fk of refFks) {
        const name = fk.constraint_name || fk.constraintName;
        if (!seen.has(name)) {
          seen.add(name);
          await this.dropForeignKey(fk.table_name, name);
        }
      }
    }
  }

  private async indexExists(indexName: string): Promise<boolean> {
    const type = this.conn.type;
    if (type === 'sqlite') {
      const res = await this.conn.get(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`, [indexName]);
      return !!res;
    } else if (type === 'mysql') {
      const res = await this.conn.get("SELECT INDEX_NAME as name FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME = ?", [indexName]);
      return !!res;
    } else if (type === 'postgresql') {
      const res = await this.conn.get("SELECT indexname as name FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1", [indexName]);
      return !!res;
    }
    return false;
  }

  private async syncIndexes(tableDef: TableDef, dryRun: boolean): Promise<void> {
    if (!tableDef.indexes) return;

    const dbType = this.getDbType();

    for (const idx of tableDef.indexes) {
      const exists = await this.indexExists(idx.name);
      if (!exists) {
        const uniqueStr = idx.unique ? 'UNIQUE' : '';
        const cols = idx.columns.map(c => this.escapeIdentifier(c)).join(', ');
        const ifNotExists = dbType === 'mysql' ? '' : ' IF NOT EXISTS';
        const sql = `CREATE ${uniqueStr} INDEX${ifNotExists} ${this.escapeIdentifier(idx.name)} ON ${this.escapeIdentifier(tableDef.name)} (${cols})`;
        if (dryRun) {
          log.sub('DRY RUN').info( `Would add index: ${idx.name}`);
          log.sub('DRY RUN').info( `SQL: ${sql}`);
        } else {
          log.info( `Adding missing index: ${idx.name}`);
          await this.execute(sql);
        }
      }
    }
  }

  private async syncColumns(tableDef: TableDef, dryRun: boolean): Promise<void> {
    const existingCols = await this.getTableColumns(tableDef.name);
    const existingNames = new Set(existingCols.map((c: any) => c.name.replace(/["'`]/g, '').trim()));
    const targetNames = new Set(tableDef.columns.map(c => c.name));

    for (const col of tableDef.columns) {
      if (!existingNames.has(col.name)) {
        const def = this.getColumnDefinitionSQL(col);
        if (dryRun) {
          log.sub('DRY RUN').info( `Would add column: ${tableDef.name}.${col.name}`);
        } else {
          log.info( `Adding missing column: ${tableDef.name}.${col.name}`);
          try {
            await this.addColumn(tableDef.name, col.name, def);
          } catch (e: any) {
            const msg = e.message?.toLowerCase() || '';

            // Column already exists (race condition on parallel runs)
            if (msg.includes('duplicate column')) {
              log.warn( `Column ${tableDef.name}.${col.name} already exists, skipping.`);
              continue;
            }

            // SQLite: ALTER TABLE cannot add UNIQUE or non-constant DEFAULT columns
            if (this.getDbType() === 'sqlite') {
              if (msg.includes('unique column') || msg.includes('unique constraint')) {
                log.warn( `Cannot add UNIQUE column ${tableDef.name}.${col.name} via ALTER in SQLite. Skipping add and relying on rebuild.`);
                continue;
              }
              if (msg.includes('non-constant default') || msg.includes('default value')) {
                log.warn( `Cannot add column ${tableDef.name}.${col.name} with non-constant default via ALTER in SQLite. Skipping add and relying on rebuild.`);
                continue;
              }
            }

            // Generic constraint fallback: strip NOT NULL → UNIQUE → both and retry
            // Works cross-DB (PostgreSQL 23502, MySQL 1048/1364, etc.) without
            // needing database-specific error code checks.
            if (!col.nullable || col.unique) {
              const relaxed = { ...col };
              let relaxedLabel = '';
              if (!col.nullable) {
                relaxed.nullable = true;
                relaxedLabel += 'NOT NULL ';
              }
              if (col.unique) {
                delete relaxed.unique;
                relaxedLabel += 'UNIQUE ';
              }
              log.warn( `Cannot add column ${tableDef.name}.${col.name}. Retrying without ${relaxedLabel.trim()} constraint.`);
              await this.addColumn(tableDef.name, col.name, this.getColumnDefinitionSQL(relaxed));
              continue;
            }

            // Unknown / unhandled error
            throw e;
          }
        }
      }
    }

    for (const existingCol of existingCols) {
      const normalizedName = existingCol.name.replace(/["'`]/g, '').trim();
      if (!targetNames.has(normalizedName)) {
        if (dryRun) {
          log.sub('DRY RUN').warn( `Would drop column: ${tableDef.name}.${existingCol.name}`);
        } else {
          log.warn( `Dropping obsolete column: ${tableDef.name}.${existingCol.name}`);
          await this.dropColumn(tableDef.name, existingCol.name);
        }
      }
    }

    let needsRebuild = false;
    const rebuildTargets: { name: string; type: string }[] = [];

    for (const col of tableDef.columns) {
      const existingCol = existingCols.find((c: any) => c.name.replace(/["'`]/g, '').trim() === col.name);
      if (existingCol) {
        const expectedType = this.mapTypeToSQL(col.type, this.getDbType(), col.length);
        // Include character_maximum_length in actual type for accurate comparison
        let actualType = existingCol.type?.toUpperCase() || '';
        if (existingCol.length != null && actualType) {
          actualType = `${actualType}(${existingCol.length})`;
        }

        const isPostgresSerial = this.getDbType() === 'postgresql' && expectedType === 'SERIAL';

        if (actualType && !isPostgresSerial && !this.isTypeCompatible(actualType, expectedType)) {
          if (this.getDbType() === 'sqlite') {
            needsRebuild = true;
            rebuildTargets.push({ name: col.name, type: expectedType });
          } else {
            if (dryRun) {
              log.sub('DRY RUN').warn( `Would modify column type: ${tableDef.name}.${col.name} (${actualType} -> ${expectedType})`);
            } else {
              log.warn( `Modifying column type: ${tableDef.name}.${col.name} (${actualType} -> ${expectedType})`);
              await this.modifyColumnType(tableDef.name, col.name, expectedType, col, existingCol.type);
            }
          }
          continue; // already modified, skip nullability check
        }

        // Check nullability change (type is compatible, but nullable differs)
        const targetNullable = col.nullable === true; // only explicit true means NULL; undefined/false means NOT NULL
        const actualNullableStr = typeof existingCol.nullable === 'string' ? existingCol.nullable.toUpperCase() : '';
        const actualNullable = actualNullableStr === 'YES' || existingCol.nullable === true;

        if (targetNullable !== actualNullable) {
          if (this.getDbType() === 'sqlite') {
            needsRebuild = true;
            rebuildTargets.push({ name: col.name, type: expectedType });
          } else {
            if (dryRun) {
              log.sub('DRY RUN').warn(`Would change column nullability: ${tableDef.name}.${col.name} (-> ${targetNullable ? 'NULL' : 'NOT NULL'})`);
            } else {
              log.warn( `Changing column nullability: ${tableDef.name}.${col.name} (-> ${targetNullable ? 'NULL' : 'NOT NULL'})`);
              await this.modifyColumnType(tableDef.name, col.name, expectedType, col, existingCol.type);
            }
          }
        }
      }
    }

    if (this.getDbType() === 'sqlite' && (needsRebuild || Array.from(targetNames).length !== Array.from(existingNames).length)) {
      await this.rebuildTableForSQLite(tableDef, dryRun);
    }
  }

  private async rebuildTableForSQLite(tableDef: TableDef, dryRun: boolean): Promise<void> {
    const tableName = tableDef.name;
    const tempName = `${tableName}_dsm_rebuild_${Date.now()}`;

    const existingCols = await this.getTableColumns(tableName);
    const existingColNames = new Set(existingCols.map((c: any) => c.name.replace(/["'`]/g, '').trim()));

    const keepCols = tableDef.columns.filter(c => {
      const normalizedName = c.name.replace(/["'`]/g, '').trim();
      return existingColNames.has(normalizedName);
    });
    const keepColNames = keepCols.map(c => this.escapeIdentifier(c.name));

    if (keepColNames.length === 0) {
      log.error( `No columns to keep during rebuild for ${tableName}. Aborting.`);
      return;
    }

    const newColDefs = tableDef.columns.map(c => {
      const normalizedName = c.name.replace(/["'`]/g, '').trim();
      if (existingColNames.has(normalizedName)) {
        return this.getColumnDefinitionSQL(c);
      }
      const def = this.getColumnDefinitionSQL(c);
      return def
        .replace(/\s+NOT\s+NULL\s*/i, ' ')
        .replace(/\s+UNIQUE\s*/i, ' ')
        .replace(/\s+PRIMARY\s+KEY\s*/i, ' ')
        .replace(/\s+AUTOINCREMENT\s*/i, ' ')
        .trim();
    }).join(', ');

    let fkClause = '';
    if (tableDef.foreignKeys && tableDef.foreignKeys.length > 0) {
      const fks = tableDef.foreignKeys
        .filter(fk => keepColNames.includes(this.escapeIdentifier(fk.column)))
        .map(fk => `FOREIGN KEY (${fk.column}) REFERENCES ${fk.refTable}(${fk.refColumn}) ON DELETE ${fk.onDelete || 'NO ACTION'}`)
        .join(', ');
      if (fks) fkClause = `, ${fks}`;
    }

    if (dryRun) {
      log.sub('DRY RUN').info( `Would rebuild SQLite table: ${tableName}`);
      return;
    }

    try {
      await this.conn.execute('PRAGMA foreign_keys = OFF');

      await this.conn.execute('BEGIN TRANSACTION');

      await this.conn.execute(`CREATE TABLE ${this.escapeIdentifier(tempName)} (${newColDefs}${fkClause})`);

      const selectExprs = keepCols.map(c => {
        const colName = this.escapeIdentifier(c.name);
        if (!c.nullable) {
          let defaultVal: string;
          if (c.defaultValue !== undefined) {
            defaultVal = this.formatDefaultValue(c.defaultValue, c.type, 'sqlite');
          } else {
            switch (c.type) {
              case 'number':
              case 'integer':
              case 'id':
                defaultVal = '0';
                break;
              case 'boolean':
                defaultVal = '0';
                break;
              case 'string':
              case 'text':
                defaultVal = "''";
                break;
              case 'datetime':
                defaultVal = "'1970-01-01 00:00:00'";
                break;
              case 'json':
                defaultVal = "'{}'";
                break;
              default:
                defaultVal = "''";
            }
          }
          return `IFNULL(${colName}, ${defaultVal})`;
        }
        return colName;
      });

      await this.conn.execute(
        `INSERT INTO ${this.escapeIdentifier(tempName)} (${keepColNames.join(', ')})
         SELECT ${selectExprs.join(', ')} FROM ${this.escapeIdentifier(tableName)}`
      );

      await this.conn.execute(`DROP TABLE ${this.escapeIdentifier(tableName)}`);
      await this.conn.execute(`ALTER TABLE ${this.escapeIdentifier(tempName)} RENAME TO ${this.escapeIdentifier(tableName)}`);

      if (tableDef.indexes) {
        const keptColumnNameSet = new Set(keepCols.map(c => c.name));
        for (const idx of tableDef.indexes) {
          const allColsExist = idx.columns.every(c => keptColumnNameSet.has(c));
          if (!allColsExist) {
            log.warn( `Skipping index ${idx.name} during rebuild: referenced columns not kept in new table`);
            continue;
          }
          const cols = idx.columns.map(c => this.escapeIdentifier(c)).join(', ');
          const unique = idx.unique ? 'UNIQUE ' : '';
          await this.conn.execute(`CREATE ${unique}INDEX IF NOT EXISTS ${idx.name} ON ${this.escapeIdentifier(tableName)}(${cols})`);
        }
      }

      await this.conn.execute('COMMIT');
      await this.conn.execute('PRAGMA foreign_keys = ON');
      log.info( `Successfully rebuilt SQLite table: ${tableName}`);
    } catch (err) {
      await this.conn.execute('ROLLBACK');
      await this.conn.execute('PRAGMA foreign_keys = ON');
      log.error( `Failed to rebuild SQLite table ${tableName}:`, err);
      throw err;
    }
  }

  private generateCreateTableSQL(table: TableDef): string {
    const dbType = this.getDbType();
    const cols = table.columns.map(c => this.getColumnDefinitionSQL(c)).join(', ');

    let sql = `CREATE TABLE IF NOT EXISTS ${this.escapeIdentifier(table.name)} (${cols}`;

    if (table.foreignKeys && table.foreignKeys.length > 0) {
      const fkClauses = table.foreignKeys.map(fk => {
        return `FOREIGN KEY (${fk.column}) REFERENCES ${fk.refTable}(${fk.refColumn}) ON DELETE ${fk.onDelete || 'NO ACTION'}`;
      }).join(', ');
      sql += `, ${fkClauses}`;
    }

    sql += ')';

    if (dbType === 'mysql') {
      sql += ` ENGINE=${table.engine || 'InnoDB'} DEFAULT CHARSET=${table.charset || 'utf8mb4'}`;
    }

    return sql;
  }

  private getColumnDefinitionSQL(col: ColumnDef): string {
    const dbType = this.getDbType();
    let sqlType = this.mapTypeToSQL(col.type, dbType, col.length);

    let def = `${this.escapeIdentifier(col.name)} ${sqlType}`;

    if (col.primaryKey) {
      def += ' PRIMARY KEY';
      if (col.autoIncrement) {
        if (dbType === 'sqlite') def += ' AUTOINCREMENT';
        else if (dbType === 'mysql') def += ' AUTO_INCREMENT';
        else if (dbType === 'postgresql') def = def.replace('INTEGER', 'SERIAL');
      }
    } else {
      if (!col.nullable) def += ' NOT NULL';
    }

    if (col.defaultValue !== undefined) {
      def += ` DEFAULT ${this.formatDefaultValue(col.defaultValue, col.type, dbType)}`;
    }

    if (col.unique) {
      def += ' UNIQUE';
    }

    return def;
  }

  private mapTypeToSQL(type: string, dbType: string, length?: number): string {
    switch (type) {
      case 'id': return dbType === 'postgresql' ? 'SERIAL' : (dbType === 'mysql' ? 'INTEGER' : 'INTEGER');
      case 'number': return dbType === 'postgresql' ? 'BIGINT' : 'BIGINT';
      case 'integer': return 'INTEGER';
      case 'boolean': return dbType === 'postgresql' ? 'BOOLEAN' : (dbType === 'mysql' ? 'TINYINT(1)' : 'INTEGER');
      case 'datetime': return dbType === 'postgresql' ? 'TIMESTAMPTZ' : 'DATETIME';
      case 'json': return dbType === 'postgresql' ? 'JSONB' : (dbType === 'mysql' ? 'JSON' : 'TEXT');
      case 'string': return length ? `VARCHAR(${length})` : (dbType === 'postgresql' ? 'TEXT' : 'TEXT');
      case 'text': return 'TEXT';
      default: return 'TEXT';
    }
  }

  private formatDefaultValue(value: any, type: string, dbType: string): string {
    if (value === null) return 'NULL';
    if (type === 'number' || type === 'integer') {
      if (typeof value === 'boolean') return value ? '1' : '0';
      return value.toString();
    }

    if (type === 'boolean') {
      if (dbType === 'postgresql') return value ? 'TRUE' : 'FALSE';
      if (dbType === 'mysql') return value ? '1' : '0';
      return value ? '1' : '0';
    }

    if (value === 'NOW()' || value === 'CURRENT_TIMESTAMP') {
      return dbType === 'postgresql' ? 'CURRENT_TIMESTAMP' : 'CURRENT_TIMESTAMP';
    }

    if (type === 'json') {
      return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
    }

    return `'${String(value).replace(/'/g, "''")}'`;
  }

  private async syncTrigger(trigger: TriggerDef, dryRun: boolean): Promise<void> {
    const dbType = this.getDbType();
    const exists = await this.triggerExists(trigger.name);

    let sql = '';
    if (dbType === 'mysql') {
      sql = `CREATE OR REPLACE TRIGGER ${trigger.name} ${trigger.timing} ${trigger.event} ON ${trigger.table} FOR EACH ROW ${trigger.body}`;
    } else if (dbType === 'postgresql') {
      const funcName = `${trigger.name}_func`;
      sql = `
        CREATE OR REPLACE FUNCTION ${funcName}() RETURNS TRIGGER AS $$
        BEGIN
          ${trigger.body}
        END;
        $$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS ${trigger.name} ON ${trigger.table};
        CREATE TRIGGER ${trigger.name} ${trigger.timing} ${trigger.event} ON ${trigger.table} FOR EACH ROW EXECUTE FUNCTION ${funcName}();
      `;
    } else if (dbType === 'sqlite') {
      sql = `CREATE TRIGGER IF NOT EXISTS ${trigger.name} ${trigger.timing} ${trigger.event} ON ${trigger.table} BEGIN ${trigger.body} END`;
    }

    if (dryRun) {
      log.sub('DRY RUN').info( `Would sync trigger: ${trigger.name}`);
    } else {
      if (!exists) {
        log.info( `Creating trigger: ${trigger.name}`);
      } else {
        log.info( `Updating trigger: ${trigger.name}`);
      }
      await this.execute(sql);
    }
  }

  private async triggerExists(triggerName: string): Promise<boolean> {
    const dbType = this.getDbType();
    if (dbType === 'sqlite') {
      const res = await this.conn.get(`SELECT name FROM sqlite_master WHERE type='trigger' AND name=?`, [triggerName]);
      return !!res;
    } else if (dbType === 'mysql') {
      const res = await this.conn.get("SELECT TRIGGER_NAME as name FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?", [triggerName]);
      return !!res;
    } else if (dbType === 'postgresql') {
      const res = await this.conn.get("SELECT tgname as name FROM pg_trigger WHERE tgname = $1", [triggerName]);
      return !!res;
    }
    return false;
  }

  private async syncView(view: ViewDef, dryRun: boolean): Promise<void> {
    const sql = `CREATE OR REPLACE VIEW ${this.escapeIdentifier(view.name)} AS ${view.query}`;

    if (dryRun) {
      log.sub('DRY RUN').info( `Would sync view: ${view.name}`);
    } else {
      log.info( `Syncing view: ${view.name}`);
      await this.execute(sql);
    }
  }

  private async syncProcedure(proc: ProcedureDef, dryRun: boolean): Promise<void> {
    const dbType = this.getDbType();
    const params = proc.parameters || '';

    let sql = '';
    if (dbType === 'mysql') {
      sql = `CREATE OR REPLACE PROCEDURE ${proc.name}${params} ${proc.body}`;
    } else if (dbType === 'postgresql') {
      sql = `CREATE OR REPLACE FUNCTION ${proc.name}${params} ${proc.body}`;
    } else if (dbType === 'sqlite') {
      log.warn( `SQLite does not support stored procedures. Skipping: ${proc.name}`);
      return;
    }

    if (dryRun) {
      log.sub('DRY RUN').info( `Would sync procedure: ${proc.name}`);
    } else {
      log.info( `Syncing procedure: ${proc.name}`);
      await this.execute(sql);
    }
  }
}