# 开发规范（导读）

> **状态：已归档导读，条文一律以仓库根 [`root.ai.md`](https://github.com/HiPM-Tech/HiDNS/blob/main/root.ai.md) 为准。**
>
> 本文件旧版（2026-10 之前）包含整套独立条文，与前端的 2026-10 重构、日志器改造、数据库四层落地全部脱节，会直接把读者带到被明令禁止的写法上（清单见文末）。现在只保留两样东西：**root.ai.md 的章节索引** 和 **root.ai.md 未收录的 CI 监听用法**。

## 一、权威规范在哪

所有工程约束集中在一份文件：[`root.ai.md`](https://github.com/HiPM-Tech/HiDNS/blob/main/root.ai.md)。本页不复制任何条文——复制就会分叉，分叉就会有过期的那一份。

| 你要找的 | 去 root.ai.md 的哪一节 |
|---|---|
| 数据库四层、调用链、BAL 操作模块清单 | §代码规范 · 数据库（1–9，含「数据库可用性判定」强制约束） |
| 日志器创建、格式、字段、限流 | §代码规范 · 日志相关（1–9；第 9 条是日志刷屏的强制约束） |
| 新增 DNS 提供商（适配器/能力位/线路/重定向） | §代码规范 · DNS提供商适配器（1–7，含 2.1 语义不变量、2.2 线路模型、2.3 重定向） |
| 环境变量与配置加载优先级 | §代码规范 · 环境配置 |
| 中间件、错误处理、`AppError` / `errors` 工厂 | §代码规范 · 中间件 |
| 路由注册、初始化门禁三态、服务归属 | §代码规范 · 路由 |
| 服务层与定时任务、`taskManager` 语义 | §代码规范 · 服务层 |
| 启动流程、初始化状态三态、优雅关闭 | §代码规范 · 应用初始化与生命周期 |
| 前端目录、模块化、权限显隐、域名虚拟分组 | §代码规范 · 客户端架构（1–6） |
| 对外 API 契约与文档同步义务 | §代码规范 · 外部应用集成 API |
| 认证方式、权限模型、安全中间件 | §代码规范 · 安全规范 |
| 门禁命令（tsc / vitest / eslint / vite build） | §代码规范 · 客户端架构 6 |
| 版本号、发布步骤、CHANGELOG | §版本发布流程 |
| 提交信息格式 | §提交信息格式 |
| 审核分级与上报机制 | §代码审核团 |

API 的方法级契约不在 `root.ai.md`，在 [`docs/api.md`](api.md)（对外 API 的唯一权威）。

## 二、CI 监听（root.ai.md 未收录，仍然有效）

GitHub Actions 的运行状态可以用 `scripts/ci-watch.mjs` 持续盯，不必反复手工 `gh run view`。

```bash
pnpm ci:watch                          # 看一次当前状态
pnpm ci:watch --logs 12                # 失败时附带失败步骤的最后 12 行日志
pnpm ci:watch --workflow release       # 只盯名称含 release 的工作流
pnpm ci:watch:loop                     # 轮询直到全部收敛
node scripts/ci-watch.mjs --fail-on-failure   # 有失败则 exit 1，可作为门禁
```

几处口径：

- **结论只看每个工作流最新的一次运行**。历史红（例如修复前的失败）不会继续污染当前状态；需要连历史一起看时加 `--all`。
- 见过的 run id 记在 `.cache/ci-watch-state.json`（已被 gitignore），新出现的运行会标 🆕 并报「本次新增 N 条」。
- 失败时会列出失败的作业与失败步骤，`--logs N` 再补上日志尾部。

依赖 `gh` CLI 并已登录。

## 三、旧版已失效条目（**不要照抄 git 历史里的旧版**）

| 旧版写的 | 现在的事实 | 依据 |
|---|---|---|
| `import { log } from '../lib/logger'` + `log.info('ModuleName', msg)` | 必须 `createLogger('MODULE')`，调用为 `log.info(msg, data?)`；带模块前缀的变量名同样被禁 | §日志相关 1–3 |
| `log.providerRequest(...)` / `log.dbQuery(...)` | 无此方法；适配器方法级日志由 `DnsHelper.ts` 的 Proxy 自动记录 | §日志相关 4、6 |
| 前端 `import { useTranslation } from 'react-i18next'` | i18n 框架与 `client/src/i18n/**` 已整体删除，界面只有简体中文 | §客户端架构 1 |
| `toast.success(...)` / `toast.error(...)` | 全局 Toast 通道已移除，页面统一用内联提示 | §客户端架构 2 |
| `client/src/pages/**`、`client/src/api/**`、`client/src/contexts/**` | 已删除；页面代码只能写在 `client/src/features/<domain>/` | §客户端架构 3 |
| 手写 `res.status(404).json({ code: -1, msg })` | 用 `errors.*` / `sendError`；信封固定 `{ code, data, msg }`，`code === 0` 表示成功 | §中间件 3、§客户端架构 4 |
| 在 `DnsHelper.ts` 的 `DNS_PROVIDERS` / switch 里注册提供商 | 该映射表不存在；提供商在 `providers/registry.ts` 声明，`adapterFactory` 装配 | §DNS提供商适配器 1 |
| Node.js >= 18 | 根 `package.json` 的 `engines` 要求 `node >= 24.22.1` | package.json |
| 旧的 Operations 清单（`SystemOperations`、`NotificationOperations`、`DomainExpiryOperations` 等） | 以 `server/src/db/bal/business-adapter.ts` 导出的 `*Operations` 为准 | §数据库 7 |

需要某项约束时，去 `root.ai.md` 对应章节引用原句；不要在本页新增条文。
