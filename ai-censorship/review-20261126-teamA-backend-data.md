# 团 A 全量评审（后端与数据）· 2026-11-26

> 成员：`reviewer-data`（数据层）、`reviewer-test`（后端契约）。
> 范围：`4e24127b` / `781e4df9` / `cade27a8`，六块全覆盖（架构、数据层、认证、前端、构建、文档测试）。

## 结论

有条件发布。三条修复的核心成立（`STORED` 生成列、`credential/publicKey`、`CURRENT_TIMESTAMP`），
但抓到两个必修 P1：**每次启动全库备份**与 **`DB_TYPE` 未知值静默回落 SQLite**。

## P1（已修）

| 问题 | 证据 | 处理 |
|---|---|---|
| `PRESERVED_COLUMNS` 只加在 `syncColumns`，`detectChangesNeeded` 仍把 `users.uk_email` 判为 schema 漂移 → 每次启动 `mysqldump`；`DSM_BACKUP_REQUIRED=true` 时备份失败直接阻断启动 | `schema-reconciler.ts:134-138` vs `:899`；`backup-manager.ts:56` | `detectChangesNeeded` 复用同一份白名单 |
| `DB_TYPE=mariadb` 等未知值走 `default:` → 静默连到新的 SQLite 文件，用户以为连的是 MariaDB | `dal/config.ts:201-204`、`connection.ts:115` | `validateEnv()` 白名单校验，未知值启动即失败并提示 MariaDB 不在支持范围 |

## P2（已修）

- 一次性迁移记账导致 #62 对存量库不可达（2.3.10/2.3.11 已记账）→ 拆出 `ensureEmailUniqueness`，每次启动执行。
- 生成列 `VARCHAR(500)` 在 COMPACT 行格式下 1071 → 降到 191（utf8mb4 下 764 字节 < 767）。
- MySQL `CURRENT_TIMESTAMP` 取会话时区，与 UTC 参数混用 → mysql2 设 `timezone: 'Z'`。
- OAuth 2FA 兜底 catch 用正则分类 401/500，含 "credential" 的服务端故障被降级 → 保留但标注为已知取舍。
- 白名单只保「名字」不校验列定义 → 记录为后续项。

## 对 issue 建议的验证

| 建议 | 结论 |
|---|---|
| #62 生成列 + 唯一索引 | 方向成立；报告给的 `PERSISTENT` 是 MariaDB 关键字，MySQL 8 只认 `VIRTUAL\|STORED` |
| #62 空串→NULL 语义 | 成立 |
| #63 改 `CURRENT_TIMESTAMP` | 成立；「等价」只在 MySQL 会话时区为 UTC 时成立 |
| #64 v13 `credential/publicKey` | 成立但不完整——没覆盖 UV，也没指出 `require()` 让 tsc 失明 |
