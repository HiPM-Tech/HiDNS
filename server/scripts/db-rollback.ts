/**
 * 数据库回滚脚本（测试用）
 * 实际调用 db-migrate.ts 的 down 模式
 */

import { loadEnv } from '../src/config/env';

// 必须先加载 .env，再碰任何数据库配置：否则 DB_TYPE/DB_PATH 全部走默认值，
// CI 的 sqlite/postgresql/mysql 矩阵会全部退化成同一个 sqlite 默认库。
loadEnv();

import { execSync } from 'child_process';
import { log } from './_logger-compat';
import path from 'path';

async function rollback() {
  log.info('DBRollback', 'Starting database rollback');

  try {
    const scriptPath = path.join(__dirname, 'db-migrate.ts');

    // 调用迁移脚本的 down 模式。
    // 必须走本地 ts-node 且带 --files：裸 `ts-node` 依赖 PATH；不带 --files 时
    // 加载不到 src/types/*.d.ts 的全局声明（node:sqlite 等），子进程会编译失败。
    const tsNodeBin = require.resolve('ts-node/dist/bin.js');
    execSync(`"${process.execPath}" "${tsNodeBin}" --files "${scriptPath}" down`, {
      cwd: process.cwd(),
      stdio: 'inherit'
    });

    log.info('DBRollback', 'Rollback completed successfully!');
    process.exit(0);
  } catch (error) {
    log.error('DBRollback', 'Rollback failed', error);
    process.exit(1);
  }
}

rollback();
