import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * 集成测试用的临时数据库。
 *
 * 历史测试（tests/*.test.ts）直接 `connect()` 然后假设表已建好，重构后 `initSchema()`
 * 只做迁移、不再建表（建表由 DSM 的 SchemaReconciler 负责），于是它们全部 `no such table`。
 * 这个助手把「临时 sqlite + DSM 建表」一次做完，并在结束时清理文件。
 */
export interface TestDbHandle {
  path: string;
  cleanup: () => Promise<void>;
}

export async function setupTestDb(): Promise<TestDbHandle> {
  const dbPath = path.join(os.tmpdir(), `hidns-test-${process.pid}-${Date.now()}.db`);
  process.env.DB_TYPE = 'sqlite';
  process.env.DB_PATH = dbPath;

  const { connect, disconnect } = await import('../../src/db/connection');
  await connect();

  const { initializeDSM } = await import('../../src/db/dsm/init-dsm');
  await initializeDSM();

  return {
    path: dbPath,
    cleanup: async () => {
      try { await disconnect(); } catch { /* 已断开 */ }
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* 忽略 */ }
      }
    },
  };
}
