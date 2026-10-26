# HiDNS 文档中心

> **单一真源原则**：文档与代码冲突时，以本页「真源」表为准；本目录其余文档都是对真源的展开或解释，冲突即改它。

## 一、真源（冲突时以此为准）

| 层级 | 文件 | 管什么 |
|---|---|---|
| 1 | [`root.ai.md`](https://github.com/HiPM-Tech/HiDNS/blob/main/root.ai.md)（仓库根） | 全部工程规范：数据库四层与调用链、日志、路由注册、DNS 提供商接入、客户端结构、门禁命令、发布流程、代码审核团 |
| 2 | [`docs/api.md`](api.md) | 对外 API 唯一权威：端点、参数、返回、鉴权、权限映射 |
| 3 | 代码本身 | `server/src/api/index.ts`（模块清单与挂载顺序）、`server/src/lib/dns/providers/registry.ts`（提供商定义）、三个 `package.json`（版本 / engines）、`LICENSE` |

改文档前先看这三处；改代码后先回写这两处（`root.ai.md` / `docs/api.md`），其余文档按需跟进。

## 二、当前事实（从真源推导，禁止手写近似值）

| 项 | 值 | 来源 |
|---|---|---|
| 版本 | 2.3.0 | 根 / `server` / `client` 的 `package.json` |
| DNS 提供商 | 26 个（`virtual` 不计入可用提供商） | `providers/registry.ts` 的 `PROVIDERS` |
| API 模块 | 23 个 | `api/index.ts` 的 `buildApiModules()` |
| Node.js | ≥ 24.22.1 | 根 `package.json` 的 `engines` |
| 数据库 | SQLite（默认）/ MySQL / PostgreSQL；四层 DL → DAL → BAL → DSM | `root.ai.md` §代码规范·数据库 |
| 前端 | React 19 + Vite 8 + React Router 7 + TanStack Query 5 + Tailwind 3.4 | `client/package.json` |
| 语言 | 单一简体中文（无 i18n 框架，2026-10 已移除） | `root.ai.md` §客户端架构 |
| 协议 | GPL-3.0 | `LICENSE` |

## 三、文档分级

### 3.1 权威文档（必须随代码同步）

| 文档 | 说明 |
|---|---|
| [API 参考](api.md) | 端点、参数、鉴权、权限映射。**新增或修改接口必须同一提交内更新** |
| [开发规范](DEVELOPMENT.md) | 仅作 `root.ai.md` 的导读与历史差异说明；规范条文以根 `root.ai.md` 为准 |
| [错误码](api-error-codes.md) | 错误码与信封约定 |
| [数据库层](architecture/database-layer.md) | DL / DAL / BAL / DSM 四层与调用链 |
| [API 路由](architecture/api-routes.md) | 模块清单、挂载顺序、服务归属与守卫（方法级细节见 `api.md`） |
| [认证与授权](architecture/authentication.md) | JWT / API Token / WebAuthn / OAuth |
| [API Token 认证](architecture/api-token.md) | 令牌模型、服务门禁、域名白名单 |
| [DNS 核心层](architecture/dns-core.md) | 提供商适配器与 registry |
| [提供商接入](providers/MIGRATION_GUIDE.md) | 新增提供商的落地步骤（以 `registry.ts` 为准） |

### 3.2 参考文档（解释性，允许滞后于代码，但不得与真源矛盾）

- [架构概览](architecture/overview.md)、[模块说明](architecture/modules.md)、[模块交互](architecture/module-interaction.md)
- [业务适配器层](architecture/business-adapter.md)、[DSM 完整分析](architecture/dsm-complete-analysis.md)、[声明式 Schema 设计](DECLARATIVE_SCHEMA_DESIGN.md)
- [虚拟 DNS 提供商](VIRTUAL_PROVIDER.md)、[加密回退](ENCRYPTION_FALLBACK.md)
- 流程类：`flow/` 下 7 篇
- 开发类（现行）：`development/quick-start.md`、`docker-deploy.md`、`configuration.md`、`task-manager.md`、`domain-list-api-format.md`
- 专题：`RESOURCE_MONITOR_DESIGN.md`、`WORKFLOW_ENGINE_DESIGN.md`（设计意图，实现以代码为准）

### 3.3 历史归档（**不作为实现依据**，仅供考古）

以下文档是某一时点的过程记录或方案稿。读它们之前先问：结论是否已落进代码或上面的权威文档？

```
refactor/00-PLAN.md            refactor/04-AUDIT-2.3.0.md
MCP_IMPLEMENTATION_PLAN.md     MCP_PROGRESS.md
WORKFLOW_ENGINE_NAMESPACE_PLAN.md   WORKFLOW_ORIGIN_GROUP_ACCOUNT_FIRST.md
RELEASE_NOTES_v1.7.2.md        FIXES.md        KNOWN_ISSUES.md
development/dsm-*.md（5 篇，含 dsm-review-summary）
development/websocket-*.md（4 篇）
development/sqlite-enabled-migration-audit.md
development/database-enabled-migration-comparison.md
development/audit-log-enhancement.md
review/（历史审查记录）
```

> 这些文件里引用的源码路径多半已在 2026-10 重构中失效：前端 `client/src/pages/`、`client/src/i18n/`、`client/src/hooks/` 已删除，后端 `server/src/db/` 的平铺结构已拆到 `dl/`、`dal/`、`bal/`、`dsm/`。引用其中代码片段前，先确认路径在 HEAD 上仍然存在。
>
> `CHANGELOG.md` 同理：它是历史记录，条目里出现的旧路径反映当时状态，**不随重构回写**。这也是上节死链自检会持续报出这些文件的原因——它们不是待修的 bug，是已归档的史料。

## 四、本地校验

```bash
# 客户端与服务端门禁（与 CI 同一套，缺一不可）
(cd client && npx tsc -b && npx vitest run && npx vite build && npx eslint .)
(cd server && npx tsc --noEmit && npx vitest run && npx eslint . --max-warnings=0)

# 文档死链自检：列出文档中引用但不存在的源码路径
grep -rhoE '\b(server|client)/src/[A-Za-z0-9_./-]+\.(ts|tsx)' docs | sort -u |
  while read -r p; do [ -e "$p" ] || echo "MISS $p"; done
```

## 五、改文档的规矩

规则条文只在一处：[root.ai.md §文档规范](https://github.com/HiPM-Tech/HiDNS/blob/main/root.ai.md)。摘要如下，**以规范原文为准**：

1. 只写可核对的数字（版本、提供商数、模块数、Node 版本、许可证），从真源取；给不出确切值就删掉该句。
2. 不复制端点表、字段表、条文——引用时给「文件 + 章节号」。
3. 过期就标不删：登记进 3.3 清单并写明「以哪份为准」；`CHANGELOG` 与归档文档不回写。
4. 新增文档必须在本页登记；纯文档改动单独提交，类型 `docs`。

---

*本页是文档索引，不是项目介绍。项目介绍见[仓库 README](../README.md)。*
