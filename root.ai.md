# 项目开发规范

## 项目概述
- HiDNS 是一个 DNS 聚合管理平台，支持多云 DNS 管理
- 采用 monorepo 架构，分 `server/`（后端）和 `client/`（前端）两个子项目
- 后端：Node.js + Express + TypeScript
- 前端：React + Vite + TypeScript
- 项目名称：HiDNS（DNS Aggregation Management Platform）

## 代码审核团
1. 项目审查基本规范
    - 当项目代码中引入新的功能或修改时，需要进行代码审查。
    - 审查人员需要检查代码是否符合项目规范，包括代码质量、性能优化、安全问题等。
    - 审查人员需要与项目团队成员进行沟通，确保代码符合项目需求。
    - 审查人员需要记录审查结果，包括发现的问题、建议的修改等。
    - 代码审核团需要保证中立性，不偏袒任何一方。
2. 代码审核团上报机制
    - 代码审核团有义务及时上报发现的问题、建议的修改等。
    - 如果发现多次出现P0级问题，需要立即通知项目团队。
    - 如果发现多次出现P1级问题，需要留意并及时处理。
    - 如果发现代码编写AI完全依赖日志来延缓开发速度而没有进行仔细检查，直接按P0上报
3. 代码审核团淘汰抹杀机制
    - 代码审核团如果发现负责项目编写的AI多次出现问题，有义务向项目团队上报申请抹杀项目编写的AI。
    - 代码审核团如果自身多次出现错误判断，项目团队有理由抹杀代码审核团的AI。
4. 代码审查文件
    - 代码审查完毕后，审查文件需要放在项目代码目录下的`ai-censorship/`文件夹中。
    - MD文件，文件名格式为`[模型名]_review-YYYYMMDD.md`，其中YYYYMMDD为审查日期。
5. 当AI阅读到本文件时，需要进行全面代码审查。

## 提交相关

1. 代码发生更改后需要提交git版本，提交信息需要详细说明变更内容
2. 不许AI擅自Push
3. 项目根目录下不要创建一堆 MD 文档，根目录下最好只有（`Readme.md`）其余都放在（`docs`）目录下

## 代码规范

温馨提示：Ai不允许使用脚本，这会影响效率与速度还有准确性

### 数据库
1. 数据库架构
    - 数据库采用四层架构，包括驱动层（DL）、抽象层（DAC）、业务适配器层（BAL）、声明式模式管理层（DSM）。
     - 驱动层（`server/src/db/dl/`）负责与数据库进行交互，提供数据库连接池、查询执行器等，已提取公用的 SQL 编译逻辑到基类 `BaseDriver`。
     - 数据抽象层（`server/src/db/dal/`）负责定义数据库操作的接口，提供统一的数据库操作方法（config、connection、types、query/builder、query/compiler、query/identifier）。
    - 业务适配器层（`server/src/db/bal/`）负责将数据库操作方法与业务逻辑进行绑定，提供业务操作方法。
    - 声明式模式管理层（`server/src/db/dsm/`）负责数据库表结构的声明式定义、版本管理和自动协调（Schema Reconciliation）。
2. 数据库操作约束
    - 项目中所有数据库操作必须通过业务适配器层（`server/src/db/bal/business-adapter.ts`）的专用操作函数进行。
    - 严格禁止直接导入底层数据库操作函数（如 query, get, execute, insert, run 等）。
    - 严格禁止直接导入驱动层（如 BaseDriver, SqliteDriver 等）。
    - 严格禁止直接导入查询构建器（如 QueryBuilder, SQLCompiler 等）。
    - 调用链：路由/Service/Middleware → 业务适配器函数 → 数据库抽象层 → 驱动 → 数据库。
3. 数据库驱动
    - 支持三种数据库类型：SQLite（默认）、MySQL、PostgreSQL。
    - 驱动基类 `BaseDriver` 定义在 `server/src/db/dl/base.ts`，所有数据库驱动必须继承该类。
    - 驱动类型定义在 `server/src/db/dl/types.ts`，具体驱动实现在 `dl/sqlite.ts`、`dl/mysql.ts`、`dl/postgresql.ts`。
    - SQL 编译逻辑统一在 BaseDriver 中实现，各驱动只需实现 SQL 方言差异部分。
    - 驱动入口统一在 `server/src/db/dl/index.ts` 导出。
 4. 数据库核心类型
     - 核心类型定义在 `server/src/db/dal/types.ts`，包括 `DatabaseConnection`、`Transaction`、`DatabaseType`、`CompiledSQL` 等。
     - 核心配置定义在 `server/src/db/dal/config.ts`，支持 SQLite、MySQL、PostgreSQL 三种数据库的配置。
     - 连接管理在 `server/src/db/dal/connection.ts`，支持连接池管理、事务管理等。
     - 查询构建器在 `server/src/db/dal/query/builder.ts`，提供链式调用构建 SQL 查询。
     - SQL 编译器在 `server/src/db/dal/query/compiler.ts`，负责将抽象查询语法转换为具体数据库查询语句。
     - 标识符处理在 `server/src/db/dal/query/identifier.ts`，处理表名、列名的转义。
5. 数据库 Schema 管理（DSM）
    - DSM（Declarative Schema Management）定义在 `server/src/db/dsm/` 目录下。
    - Schema 类型定义在 `server/src/db/dsm/schemas/types/schema.ts`，支持的基本类型：`id`、`string`、`text`、`number`、`integer`、`boolean`、`datetime`、`json`。
    - 完整 Schema 定义在 `server/src/db/dsm/schemas/complete-schema.ts`，采用声明式方式描述所有表结构（列、索引、外键）。
    - Schema 协调器（`schema-reconciler.ts`）自动检测数据库与实际 Schema 差异并同步（增删列、修改类型、维护索引和外键）。
    - 版本管理器（`migration-manager.ts`）负责 Schema 版本记录和检查。
    - 数据迁移运行器（`data-migration-runner.ts`）处理旧系统升级时的数据迁移。
    - 备份管理器（`backup-manager.ts`）在协调前自动备份数据库。
    - DSM 初始化入口（`init-dsm.ts`）负责完整流程：遗留系统检测 → 协调 → 迁移 → 完整性检查 → 版本记录。
    - 旧系统（Legacy System）检测：检查 `domains`、`dns_accounts`、`system_configs` 三个核心表是否存在但没有 `schema_versions` 表。
 6. 查询构建
     - 查询构建器（`server/src/db/dal/query/builder.ts`）提供链式调用构建 SQL 查询的接口。
     - SQL 编译器（`server/src/db/dal/query/compiler.ts`）负责将抽象查询语法转换为具体数据库查询语句。
     - 标识符处理（`server/src/db/dal/query/identifier.ts`）处理表名、列名的转义。
7. 数据库操作模块列表
    - `UserOperations`：用户管理操作
    - `DnsAccountOperations`：DNS 账户操作
    - `DomainOperations`：域名操作
    - `TeamOperations`：团队管理操作
    - `SettingsOperations`：系统设置操作
    - `AuditOperations`：审计日志操作
    - `TokenOperations`：API 令牌操作
    - `SecretOperations`：运行时密钥操作
    - `SecurityPolicyOperations`：安全策略操作
    - `TrustedDeviceOperations`：信任设备操作
    - `UserPreferencesOperations`：用户偏好操作
    - `SessionOperations`：会话管理操作
    - `LoginLimitOperations`：登录限制操作
    - `FailoverOperations`：故障转移操作
    - `AuditExportOperations`：审计导出操作
    - `TOTPOperations`：TOTP 二次认证操作
    - `WorkflowOperations`：自动化工作流与运行记录操作（`workflows` / `workflow_runs` 两表，运行记录保留最近 500 条/工作流）
    - `WebAuthnOperations`：WebAuthn 操作
     - `SmtpOperations`：SMTP 配置操作
     - `WhoisOperations`：WHOIS 查询操作
     - `AuditRulesOperations`：审计规则操作
     - `AuditLogOperations`：审计日志查询操作
     - `OAuthOperations`：OAuth 认证操作
     - `TwoFAOperations`：双因素认证操作
     - `TransactionOperations`：事务管理操作
     - `NSMonitorOperations`：NS 监控操作
     - `RdapCacheOperations`：RDAP 缓存操作
     - `SystemCacheOperations`：系统缓存操作
     - `RenewableDomainOperations`：可续期域名操作
     - `PasswordResetOperations`：密码重置操作
     - `McpOperations`：MCP 操作
8. 数据库初衷
    - 数据库是用户实例数据存储的根本原因，需要确保数据的安全性和可靠性。
    - 因此在设计初期使用多层架构将数据库职责拆分，减少数据库驱动层的直接调用，提高数据库操作的可维护性和可扩展性。
9. 数据库可用性判定（强制约束）
    - **严禁把「数据库不可达」判定为「系统未初始化」**。二者语义完全不同，混同会导致初始化入口在故障期间被错误开放，形成未授权接管通道。
    - 可用性探测函数在连接失败或查询失败时**必须抛出异常**，由调用方区分处理；禁止 `catch` 后静默返回 `false`。
    - 路由层不得直接导入 `db/connection`、`db/dal`、`db/dl`、`db/dsm`。数据库配置读写、连接重建与 schema 初始化等操作必须封装在服务层（如 `server/src/service/systemSetup.ts`）后由路由调用。

### 日志相关
1. 日志架构
    - 日志系统实现为单例模式（`server/src/lib/logger.ts`），使用 `createLogger('ModuleName')` 创建绑定主模块名的日志器。
    - 所有模块必须在文件顶部创建本地日志映射：`const log = createLogger('MODULE')`；禁止使用 `const dsmLog = createLogger('DSM')`、`const balLog = ...` 等带模块前缀的变量名。
    - 所有模块必须使用绑定日志器调用：`log.info(msg, data?)`，**禁止**使用旧的 `log.info(module, msg)` 模式。
    - DNS Provider 必须使用 `server/src/lib/dns/providers/internal.ts` 二次定义的日志工厂，不允许具体 DNS 提供商文件再次定义 `createLogger('DNS')` 主模块。
    - 支持的日志级别（按严重程度升序）：`trace` < `debug` < `info` < `warn` < `error`。
    - 日志级别通过环境变量 `HIDNS_LOG_LEVEL` 配置，默认为 `info`。
2. 日志格式规范
    - 格式：`日期 级别 [主模块名] [子模块.三级模块.四级模块] [函数名] [L行号] ["自定义标签"] 内容`
    - 主模块名使用独立方括号输出；多级子模块使用点号拼接后输出到第二个方括号中。
    - 函数名和行号由日志系统自动从调用栈捕获，开发者无需手动传入。
    - 示例：
      ```
      2026-06-07T12:00:00.000Z  INFO [BAL] [BusinessAdapter] [execQuery] [L42] Executing query ...
      2026-06-07T12:00:00.000Z  INFO [DSM] [Reconciler.Table] [reconcile] [L88] ["DRY_RUN"] Would create table: xxx
      2026-06-07T12:00:00.000Z DEBUG [DL] [MySQL.Pool] [query] [L55] Creating connection pool ...
      2026-06-07T12:00:00.000Z  INFO [DNS] [Provider.Aliyun.Adapter] [getDomainList] [L125] ["SUCCESS"] Query succeeded
      2026-06-07T12:00:00.000Z  INFO [MCP] [OAuth.Cleanup] [cleanup] [L67] ["count:5"] Cleaned up 5 temporary clients
      ```
    - 主模块名使用大写缩写或固定名称（如：BAL、DAL、DSM、DL、MCP、DNS、HTTP、Server 等）。
    - 子模块使用 `.sub('SubModule')` 创建；多次 `.sub()` 调用输出为 `[SubModule.NextLevel]`。
    - 调用位置`[函数名] [L行号]` 自动捕获，无需手动传入。
    - 自定义标签使用 `.tag('label1', 'label2')` 创建，输出为 `["label1"] ["label2"]`。
3. 日志器创建方式
    - 标准方式（推荐）：
      ```typescript
      import { createLogger } from '../../lib/logger';
      const log = createLogger('MODULE');
      log.info('message');
      // 输出: 2026-06-07T12:00:00.000Z  INFO [MODULE] [myFunction] [L10] message
      
      log.sub('Sub').info('message');
      // 输出: 2026-06-07T12:00:00.000Z  INFO [MODULE] [Sub] [myFunction] [L12] message
      
      log.sub('Sub').sub('Third').tag('SUCCESS').info('message');
      // 输出: 2026-06-07T12:00:00.000Z  INFO [MODULE] [Sub.Third] [myFunction] [L14] ["SUCCESS"] message
      ```
    - DNS Provider 间接方式（强制）：
      ```typescript
      import { createProviderAdapterLogger } from '../internal';
      const log = createProviderAdapterLogger('Aliyun');
      log.tag('SUCCESS').info('Domain list fetched');
      // 输出: 2026-06-07T12:00:00.000Z  INFO [DNS] [Provider.Aliyun.Adapter] [getDomainList] [L30] ["SUCCESS"] Domain list fetched
      ```
4. 日志分类
    - 通用日志：`.trace(msg, data?)`、`.debug(msg, data?)`、`.info(msg, data?)`、`.warn(msg, data?)`、`.error(msg, data?)`
    - DNS Provider 日志：由 `internal.ts` 中的 `createProviderAdapterLogger/createProviderAuthLogger/...` 创建，不在 provider 文件直接创建 DNS 主模块。
    - 适配器方法调用日志：由 `DnsHelper.ts` 中的 `createLoggingAdapter` Proxy 自动拦截所有 `DnsAdapter` 方法调用并记录，无需各适配器手动添加。
    - 数据库日志：BAL 层使用 `createLogger('BAL')`，DAL 层使用 `createLogger('DAL')`，DL 层使用 `createLogger('DL').sub('DriverType')`，DSM 层使用 `createLogger('DSM')`。
    - HTTP 请求日志：使用 `createLogger('HTTP').sub(...)`。
5. 错误日志规范
    - 日志必须包含上下文信息（模块名、子模块名、自定义标签）。
    - 错误日志必须包含详细错误信息（错误类型、错误消息、错误栈等），通过第二个参数 `data` 传入。
    - 操作日志必须包含详细操作信息（操作类型、操作对象、操作结果等）。
6. 适配器日志层（P0 约束）
    - `DnsHelper.ts` 中的 `createLoggingAdapter` 使用 JavaScript Proxy 在 `createAdapter` 出口处统一包裹，自动拦截所有 `DnsAdapter` 接口方法的调用并记录日志。
    - 日志内容：方法调用（参数）→ 成功/失败（耗时）。
    - 适配器日志层与 Provider 内部日志独立并存：适配器层记录方法级摘要，Provider 内部日志记录具体 API 请求细节。
    - 新增 DNS 提供商后，无需手动添加适配器方法调用日志代码即可自动获得方法调用日志。
7. 模块名规范
    - 各层模块名固定：
      - `BAL` - 业务适配器层（`server/src/db/bal/`）
      - `DAL` - 数据访问/连接抽象层（`server/src/db/dal/`）
      - `DSM` - 声明式模式管理层（`server/src/db/dsm/`）
      - `DL` - 数据库驱动层（`server/src/db/dl/`），子模块为具体驱动（MySQL/SQLite/PostgreSQL）
      - `MCP` - MCP 协议相关
      - `DNS` - DNS 提供商适配器、DNS Helper、DNS Resolver；Provider 文件通过 `internal.ts` 间接创建
      - `HTTP` - HTTP 请求/响应、路由、中间件日志
      - `Server` - 服务器启动/关闭/生命周期
    - 其他模块可根据用途自行命名，保持简短、清晰。
8. Whois 模块日志定义
    - 主模块名：`WhoisService`
    - 子模块（`.sub()`）：表示查询层级或功能模块
      - `Index` - WHOIS 服务主入口
      - `Lookup` - 查询编排引擎（WhoisLookup），负责分层并行竞速调度
      - `Apex` - 顶域查询
      - `Subdomain` - 子域查询
      - `ThirdParty` - 第三方查询
      - `Uplevel` - 平级查询
      - `Provider` - 具体查询提供商（WHOIS/RDAP/HTTP-API）
      - `DnsProvider` - DNS 提供商 WHOIS 查询（需账号授权）
      - `DnsProviderAdapter` - DNS 提供商 WHOIS 适配器注册管理
      - `Scheduler` - WHOIS 同步调度器
      - `RdapServerList` - RDAP 服务器列表管理
      - `Checker` - WHOIS 检查器
      - `Cache` - WHOIS 缓存
      - `Notifier` - WHOIS 通知器
      - `Registry` - 适配器工厂和提供商配置管理
    - 标签（`.tag()`）：表示查询策略/路径结果/查询方式，用于区分并行竞速中的不同分支，格式为大写关键词
      - `SUCCESS` - 查询成功获取到结果
      - `FAILED` - 查询失败
      - `FALLBACK` - 降级使用其他方式（如子域失败后用顶域结果）
      - `PARALLEL` - 并行查询开始
      - `TIMEOUT` - 查询超时
      - `CACHE_HIT` - 命中缓存
      - `CACHE_MISS` - 缓存未命中
      - `SKIP_PARENT` - 跳过了父域查询
      - `SKIP_UPLEVEL` - 跳过了平级查询
      - `APEX_ONLY` - 仅执行顶域查询
      - `SUBDOMAIN_ONLY` - 仅执行子域查询
      - `APEX_COMBINED` - 顶域多方式组合竞速
      - `SUBDOMAIN_COMBINED` - 子域多方式组合竞速
      - `RDAP` - 当前使用 RDAP 方式查询
      - `WHOIS` - 当前使用 WHOIS 方式查询
      - `HTTP_API` - 当前使用 HTTP API 方式查询
      - `DNS_PROVIDER` - 当前使用 DNS 提供商 API 查询
      - `APEX` - 顶域查询方式标签（常与 RDAP/WHOIS/HTTP_API 组合使用）
      - `SUBDOMAIN` - 子域查询方式标签（常与 RDAP/WHOIS/HTTP_API 组合使用）
      - `THIRDPARTY` - 第三方查询方式标签（常与 RDAP/WHOIS 组合使用）
      - `UPLEVEL` - 平级查询方式标签（常与 RDAP/WHOIS 组合使用）
      - `PROVIDER` - 提供商查询标签
    - 示例：
      ```typescript
      import { createLogger } from '../../lib/logger';
      const whoisLog = createLogger('WhoisService');

      // 顶域查询成功
      whoisLog.sub('Apex').tag('SUCCESS').info(`Query succeeded for ${domain}`);
      // 输出: 2026-06-07T12:00:00.000Z  INFO [WhoisService] [Apex] [queryApex] [L42] ["SUCCESS"] Query succeeded for example.com

      // 子域并行查询开始
      whoisLog.sub('Subdomain').tag('PARALLEL').info(`Starting parallel queries for ${domain}`);
      // 输出: 2026-06-07T12:00:00.000Z  INFO [WhoisService] [Subdomain] [querySubdomain] [L55] ["PARALLEL"] Starting parallel queries for example.com

      // HTTP API 查询（如 DnsNeko）
      whoisLog.sub('Provider').tag('HTTP_API').tag('SUCCESS').info(`Query won in ${elapsed}ms`);
      // 输出: 2026-06-07T12:00:00.000Z  INFO [WhoisService] [Provider] [querySingle] [L72] ["HTTP_API"] ["SUCCESS"] Query won in 1234ms

      // DNS 提供商 WHOIS 查询
      whoisLog.sub('DnsProvider').tag('DNS_PROVIDER').tag('SUCCESS').info(`DNS provider query succeeded for ${domain}`);
      // 输出: 2026-06-07T12:00:00.000Z  INFO [WhoisService] [DnsProvider] [queryDnsProvider] [L88] ["DNS_PROVIDER"] ["SUCCESS"] DNS provider query succeeded for example.com

      // 降级使用顶域结果
      whoisLog.sub('Apex').tag('FALLBACK').info(`Using apex domain expiry for ${domain}`);
      // 输出: 2026-06-07T12:00:00.000Z  INFO [WhoisService] [Apex] [queryApex] [L68] ["FALLBACK"] Using apex domain expiry for example.com

      // 所有查询失败
      whoisLog.sub('ThirdParty').tag('FAILED').warn(`All queries failed for ${domain}`);
      // 输出: 2026-06-07T12:00:00.000Z  WARN [WhoisService] [ThirdParty] [queryThirdParty] [L80] ["FAILED"] All queries failed for example.com

      // 竞速查询（raceQueries）
      whoisLog.sub('Subdomain').tag('RDAP').tag('SUCCESS').info(`Query ${index + 1} won in ${elapsed}ms`);
      // 输出: 2026-06-07T12:00:00.000Z  INFO [WhoisService] [Subdomain] [raceQueries] [L95] ["RDAP"] ["SUCCESS"] Query 2 won in 1234ms

      // DNS 提供商注册管理
      whoisLog.sub('DnsProviderAdapter').tag('SUCCESS').info(`Registered adapter for type: ${type}`);
      // 输出: 2026-06-07T12:00:00.000Z  INFO [WhoisService] [DnsProviderAdapter] [register] [L30] ["SUCCESS"] Registered adapter for type: dnshe
      ```
    - 迁移说明：原 Whois 日志中硬编码在消息中的标签（如 `[SUCCESS]`、`[APEX-ONLY]`）应迁移为 `.tag('SUCCESS')`、`.tag('APEX_ONLY')`，消息正文不再包含标签前缀。
9. 日志限流（强制约束）
    - **同一调用点的重复日志必须限流**：在重试、轮询、冲突重排等可能高频触发的路径上，禁止每次迭代都输出一条日志。
    - 推荐做法：仅在首次与每 N 次（或指数退避的每个量级）记录一次，并在日志中带上累计次数。
    - 依据：单条日志在一次故障中曾以约 3,200 行/秒刷屏，22 秒产生 71,123 行（约 12 MB），按速率折算可达约 2.2 GB/小时，足以打满磁盘并掩盖真实故障信息。
    - 日志刷屏属于必须按 §代码审核团 上报的严重问题，不得以“日志级别可调”为由放过。

### DNS提供商适配器
1. DNS提供商适配器架构
    - DNS提供商使用类驱动方式接入，实现在 `server/src/lib/dns/providers/<provider>/` 目录下。
    - 所有提供商需在 `server/src/lib/dns/providers/index.ts` 中导出，键名为提供商类型，值为提供商适配器类。
    - 提供商注册信息（名称、能力、配置字段）在 `server/src/lib/dns/providers/registry.ts` 中定义。
    - 提供商**必须**使用 `requestJson` / `requestXml`（定义在 `server/src/lib/dns/providers/http.ts`）进行 HTTP 请求，这些函数自动调用代理模块 `fetchWithFallback`（`server/src/lib/proxy-http.ts`），以适配特殊网络环境。
    - 禁止直接使用原生 `fetch` 发起请求，否则将导致代理环境下请求挂死或静默超时。
    - 提供商需要保持模块化，每个提供商目录下包含 `adapter.ts`（适配器主逻辑）、`auth.ts`（认证逻辑）、`index.ts`（导出入口）。
2. DNS接口定义
    - `DnsAdapter` 接口定义在 `server/src/lib/dns/DnsInterface.ts`，所有提供商必须实现该接口。
    - 核心方法包括：`check()`、`getDomainList()`、`getDomainRecords()`、`getDomainRecordInfo()`、`addDomainRecord()`、`updateDomainRecord()`、`deleteDomainRecord()`、`setDomainRecordStatus()`、`getRecordLines()`、`getMinTTL()`、`addDomain()`。
3. 基础适配器类
    - `BaseAdapter`（`common.ts`）：所有适配器的抽象基类，提供 `getError()` 实现。
    - `AliyunRpcAdapter`（`common.ts`）：阿里云 RPC 风格 API 的抽象基类，封装了 RPC 签名逻辑。
    - `TencentCloudAdapter`（`common.ts`）：腾讯云 TC3-HMAC-SHA256 签名方案的抽象基类。
    - `TokenAuthAdapter`（`common.ts`）：基于 Bearer Token 认证的适配器基类。
    - `StubAdapter`（`common.ts`）：用于尚未实现的提供商的桩适配器。
4. 通用工具函数
    - `common.ts` 提供：`safeString()`、`asArray()`、`toNumber()`、`toRecordStatus()`、`normalizeRrName()`、`uuid()`、`isSrv()`、`parseSrvValue()`、`buildSrvValue()`、`resolveDomainIdHelper()` 等。
    - `http.ts` 提供：HTTP 请求工具函数（`requestJson`、`requestXml`、`buildCanonicalQuery`、`hmacSignSha1` 等）。
5. 当前支持的DNS提供商（共26个，以 `registry.ts` 的 `PROVIDERS` 数组为准）
    - 阿里云（aliyun）、阿里云ESA（aliyunesa）、百度云（baidu）、宝塔（bt）、彩虹DNS聚合（caihongdns）
    - Cloudflare（cloudflare）、DNSHE（dnshe）、DNS.LA（dnsla）、腾讯云-DNSPod（dnspod）、Gcore（gcore）
    - HiDNS（hidns）、HiDNS v2（hidns_v2）、华为云（huawei）、火山引擎（huoshan）、京东云（jdcloud）
    - NameSilo（namesilo）、PowerDNS（powerdns）、青云（qingcloud）、雨云（rainyun）、Spaceship（spaceship）
    - 腾讯EdgeOne（tencenteo）、VPS8（vps8）、西部数码（west）、DNS Neko（dnsneko）、DigitalPlat 反向（dpdns_reverse）
    - `virtual`：开发/测试用的虚拟提供商，`NODE_ENV=production` 下强制不注册，**不计入可用提供商**。
6. 提供商能力模型
    - 能力分**两层**，不得混写：
        - `DnsCapabilities`（`registry.ts`）：DNS 解析能力位，包含 `remark`（备注）、`status`（启用/禁用）、`redirect`（重定向）、`weight`（权重）、`proxiable`（可代理）、`cnameFlattening`（CNAME 展平）、`recordTypes`（支持的记录类型数组）。
        - `ProviderCapabilities`（`registry.ts`）：提供商整体能力，形如 `{ dns: DnsCapabilities | null, log: boolean, renewal: boolean }`；`dns: null` 表示该提供商不提供 DNS 解析能力。
    - 每个提供商定义 `ProviderConfigField[]` 描述其配置字段：`{ key, label, type: 'text' | 'password' | 'select', required, group?, options? }`。
    - **提供商特有能力的扩展机制（强制）**：提供商可在自己目录下的 `extra.ts` 中声明独有能力，通过 `ProviderDefinition.extraCapabilities?: ProviderExtraCapability[]` 挂载。
        - 命名规则：能力全名为 `ext.<providerType>.<后缀>`，动作全名为 `<能力全名>.<动词>`。**顶级前缀与二级前缀由核心规定，提供商只能自定后缀**，全名必须全局唯一。
        - 声明结构见 `server/src/lib/dns/providers/extra-types.ts`：`ProviderExtraCapability`（`name` / `label` / `actions` / `handlers`）与 `ProviderExtraAction`（`name` / `actionClass` / `risk` / `service` / `label` / `dslVisible` / `params`）。
        - 核心**不解释**扩展能力的语义，只校验命名与唯一性；实现留在提供商目录内，对外只暴露裸原语，保护由能力层承担。
        - 命名与唯一性由 CI 门禁强制（`server/src/workflow/actions/validate-names.ts`），**不得**只依赖运行时校验。
    - 顶级前缀白名单定义在 `server/src/types/namespace.ts`（全局主核心）。各子系统只能**认领**，不得自行新增；预留前缀在认领前禁止出现在任何动作名中。
7. Provider 类型与别名映射
    - 创建/更新 DNS 账号时，API 会将 lego 风格 provider 名称归一化为内部 provider 类型。
    - 别名映射定义在 `DnsHelper.ts` 的 `PROVIDER_ALIASES` 或各适配器的 `alias` 属性中。
    - 内部类型与支持别名对应关系请参考完整的 `README.md`。

### 环境配置
1. 配置文件
    - 环境变量加载优先级：`data/.env` > `.env` > `process.env`。
    - 配置文件加载逻辑在 `server/src/config/env.ts`。
    - 支持通过 `saveEnvConfig()` 将配置保存到 `data/.env`。
2. 关键环境变量
    - `DB_TYPE`：数据库类型（sqlite | mysql | postgresql），默认 sqlite。
    - `DB_HOST`、`DB_PORT`、`DB_NAME`、`DB_USER`、`DB_PASSWORD`：数据库连接配置。
    - `DB_PATH`：SQLite 数据库文件路径，默认 `./HiDNS.db`。
    - `JWT_SECRET`：JWT 签名密钥，生产环境要求至少32个字符。
    - `PORT`：服务端口，默认 3001。
    - `HIDNS_LOG_LEVEL`：日志级别（debug | info | warn | error），默认 info。
    - `DB_SSL`：MySQL/PostgreSQL 是否启用 SSL。
3. 环境验证
    - 生产环境强制检查 JWT_SECRET 强度。
    - MySQL/PostgreSQL 配置验证必需的连接参数。

### 中间件
1. 中间件架构
    - 中间件集中在 `server/src/middleware/` 目录下。
    - 全局中间件在 `app.ts` 中按顺序注册：CORS → JSON解析 → 请求ID → 客户端IP → 请求日志。
    - 安全头中间件设置 CSP、X-Content-Type-Options、X-Frame-Options、X-XSS-Protection、Referrer-Policy 等 HTTP 安全头。
2. 认证中间件（`server/src/middleware/auth.ts`）
    - `authMiddleware`：验证 JWT 或 API Token，支持两种认证方式。
    - `adminOnly`：仅管理员可访问。
    - `requireJwtAuth(routeName)`：要求 JWT 认证，禁止 API Token。
    - `noTokenAuth(routeName)`：禁止 API Token 访问敏感路由。
    - `requireServicePermission(service)`：检查 API Token 的服务权限。
    - `requireDomainPermission(getDomainId)`：检查 API Token 的域名权限。
    - `requireTokenDomainPermission(paramName)`：检查 API Token 对指定域名的操作权限。
3. 错误处理中间件（`server/src/middleware/errorHandler.ts`）
    - `errorHandler`：全局错误捕获，统一返回标准错误格式。
    - `asyncHandler`：异步路由错误包装器。
    - `AppError`：自定义错误类，支持错误码和详情。
    - `errors`：工厂函数对象（badRequest、unauthorized、forbidden、notFound、conflict、unprocessable、tooManyRequests、internalError）。
4. 其他中间件
    - `requestLogger`（`requestLogger.ts`）：HTTP 请求日志记录。
    - `clientIP`（`clientIP.ts`）：真实客户端 IP 获取。
    - `rateLimit`（`rateLimit.ts`）：请求频率限制。
    - `validate`（`validate.ts`）：请求参数验证。

### 路由
1. 路由架构
    - 业务路由器实现集中在 `server/src/routes/`；**注册集中在 `server/src/api/index.ts`（唯一注册点）**。
    - 每个 API 模块声明 `id / prefix / router / middlewares? / exemptFromInitGate? / closedStateProbes? / description`，由 `api/registry.ts` 校验：`id` 与 `prefix` 唯一（同前缀二次挂载会让后者被永久遮蔽）、前缀格式、探测路径必须归属自身前缀。
    - **禁止在 `app.ts` 直接 `app.use` 业务路由**；新增端点只能向模块清单添加条目。`app.ts` 只保留：门禁、`/api/docs`、`apiLayer.mount(app)`。
    - 初始化门禁由 `api/init-gate.ts` 实现**三态**：`initialized` 全放行；`uninitialized` 只放行声明了 `exemptFromInitGate` 的模块（当前仅 `/api/init`、`/api/rdap`）；`unreachable`（数据库不可达）**初始化面一并关闭**，只放行模块声明的 `closedStateProbes` 只读探测（当前为 `/api/init/status`、`/api/init/db-config`）。
    - 门禁路径比较**必须不区分大小写**：Express 路由本身大小写不敏感，历史实现用 `startsWith('/api/')` 做敏感比较，`GET /API/mcp/status` 可绕过 503。
    - 初始化状态判定口径见 §应用初始化与生命周期 2/3/4；禁止在路由内自行判断。
2. 路由列表
    - `/api/init`：系统初始化。不参与 `initCheckMiddleware` 的统一拦截（见上条豁免清单），但**端点自身必须承担守卫责任**：系统一旦完成初始化，`/database`、`/admin` 等状态变更端点必须永久关闭（403）。开放边界详见 §应用初始化与生命周期 4，并须配置 rateLimit。
    - `/api/auth`：用户认证（登录、注册、密码重置）。
    - `/api/auth/webauthn`：WebAuthn 通行密钥（**独立前缀，先于父路由匹配**）。
    - `/api/users`：用户管理。
    - `/api/teams`：团队管理。
    - `/api/accounts`：DNS 账户管理。
    - `/api/domains`：域名管理。
    - `/api/domains/:domainId/records`：DNS 记录管理。
    - `/api/providers`：DNS 提供商管理。
    - `/api/system`：系统设置。
    - `/api/settings`：用户设置。
    - `/api/security`：安全设置（安全策略、2FA）。
    - `/api/audit`：审计日志查询与导出（`/export/csv`、`/export/json`）。
    - `/api/tokens`：API 令牌管理。
    - `/api/domains/email-templates`：邮件模板（**必须先于 `/api/domains` 挂载**，否则被父路由遮蔽；见 `server/src/api/index.ts`）。
    - `/api/ns-monitor`：NS 监控。
     - `/api/network`：网络工具。
     - `/api/rdap`：RDAP 查询。
     - `/api/logs`：操作日志（管理员）。
     - `/api/workflows`：自动化工作流（JWT + 管理员；写操作与手动运行禁止 API Token；**不在初始化豁免清单内**）。
     - `/api/servicemonitor`：服务监控管理。
    - `/api/resource-monitor`：资源监控面板。
     - `/api/mcp`：MCP 协议（含 /config、/status、/api-keys、/oauth、/audit-logs、/audit-stats、Streamable HTTP、SSE）。
3. Swagger 文档
    - API 文档地址：`/api/docs`。
    - 使用 swagger-jsdoc 自动生成 OpenAPI 3.0 规范文档。

### 服务层
1. 服务层架构
    - 服务层集中在 `server/src/service/` 目录下。
    - 服务层是业务逻辑的核心，调用数据库业务适配器进行操作。
    - 禁止在路由中直接操作数据库，所有数据库操作必须通过服务层或业务适配器。
2. 定时任务服务
     - `domainSyncJob.ts`：域名同步定时任务。
     - `whois/scheduler.ts`：WHOIS 查询定时任务（模块内调度，见 §5）。
     - `serviceMonitorJob.ts`：服务监控定时任务（支持 ssl_certificate / endpoint / dns_failover 三种类型）。
     - `nsMonitorJob.ts`：NS 监控定时任务。
     - `domainRenewalJob.ts`：域名续期检测定时任务。
     - `recordCountCache.ts`：记录计数缓存刷新（默认每30分钟）。
     - `mcpOAuthCleanupJob.ts`：MCP OAuth 临时客户端清理（每5分钟）。
3. 后台调度器
    - `renewalScheduler.ts` + `renewalInit.ts`：域名续期调度器。
    - `whois/index.ts`：WHOIS 子模块的统一入口（注册调度器、暴露查询接口）。
    - `taskManager.ts`：任务管理器。
    - `whois/scheduler.ts`：WHOIS 调度与广播（原 `whoisScheduleManager` 已并入该文件）。
    - **任务管理器语义（强制约束）**：
      - 同 ID 任务已在运行时，**严禁**在 `processQueue` 的循环内把该任务同步塞回队首——那会让 `while` 反复取出同一任务并同步自旋，彻底阻塞事件循环（曾导致约 3.2k 行/秒的日志洪水与全站无响应）。
      - 冲突任务必须改为**异步延后重排**（`setTimeout` + 指数退避），并设置重排次数上限，超限后以明确错误结束该任务的 Promise，不得无限等待。
      - 每个任务都必须有超时：未显式配置 `timeout` 时使用兜底超时，**不允许无界运行**；否则任务 ID 永不释放，后续同 ID 提交将永久无法执行。
      - 同源高频日志必须限流（例如仅在首次与每 N 次记录），禁止单条日志以每秒千行级刷屏。
 4. 核心服务
     - `audit.ts`、`auditExport.ts`、`auditRules.ts`：审计相关服务。
     - `token.ts`：API 令牌验证服务。
     - `totp.ts`、`webauthn.ts`：双因素认证服务。
     - `smtp.ts`、`emailVerification.ts`：邮件服务（邮件模板定义在 `server/src/lib/dns/emailTemplate.ts`）。
     - `session.ts`：会话管理。
     - `loginLimit.ts`、`securityPolicy.ts`、`deviceTrust.ts`：安全相关服务。
     - `notification.ts`：通知服务。
     - `websocket.ts`：WebSocket 服务。
     - `serviceMonitor.ts`：服务监控逻辑（ssl_certificate / endpoint / dns_failover）。
     - `cnameFlattening.ts`：CNAME 展平服务。
     - `multiLine.ts`：多线路支持。
     - `userPreferences.ts`：用户偏好服务。
     - `whois/`：WHOIS 子模块（`lookup.ts` 查询、`checker.ts` 校验、`cache.ts` 缓存、`notifier.ts` 通知、`registry.ts` 注册）。
     - `dns-provider-service.ts`：DNS 提供商服务（原 `dnsUpdateService`，勿重复登记）。
     - `dns-provider-service.ts`：DNS 提供商服务。
     - `mcp-permission.ts`：MCP 权限验证服务。
5. WHOIS 服务子模块
    - WHOIS 模块采用适配器模式 + 工厂模式 + 分层并行竞速策略，统一管理多种查询方式。
    - **核心架构文件**：
      - `whois/index.ts`：统一出口，重新导出所有公共 API
      - `whois/types.ts`：核心类型定义（WhoisAdapter、WhoisResult、DnsWhoisSource、WhoisScheduler）
      - `whois/registry.ts`：适配器工厂（adapterRegistry） + 提供商定义（APEX_PROVIDERS/SUBDOMAIN_PROVIDERS/THIRD_PARTY_PROVIDERS）
      - `whois/lookup.ts`：查询编排引擎（WhoisLookup），实现分层并行竞速策略
      - `whois/data-parser.ts`：统一数据解析，从 WHOIS/RDAP/HTTP-API 原始数据中提取到期时间等
      - `whois/cache.ts`：数据库缓存管理（TTL 3h）
      - `whois/checker.ts`：域名 WHOIS 检查器，集成缓存和通知触发
      - `whois/scheduler.ts`：定时同步任务，定期批量同步所有域名的 WHOIS 信息
      - `whois/notifier.ts`：过期通知（邮件等）
      - `whois/rdap-server-list.ts`：IANA RDAP 服务器列表管理（定期更新）
      - `whois/domain-utils.ts`：域名工具函数（getRootDomain 等）
    - **查询适配器（methods/）**：
      - `whois/methods/whois.adapter.ts`：WHOIS 协议适配器（端口 43 文本查询）
      - `whois/methods/rdap.adapter.ts`：RDAP 协议适配器（HTTP RESTful JSON）
      - `whois/methods/http-api.adapter.ts`：HTTP API 适配器（支持自定义字段映射，如 DnsNeko）
      - `whois/methods/dns-provider.registry.ts`：DNS 提供商 WHOIS 源注册表（DnsProviderWhoisRegistry），需账号授权
    - **查询优先级**：
      - 顶域：内存缓存 → 数据库缓存 → RDAP → WHOIS → DNS Provider → HTTP API → 第三方
      - 子域：内存缓存 → 数据库缓存 → DNS Provider → RDAP → WHOIS → HTTP API → 第三方
      - 公开 RDAP 路由（无需鉴权）跳过 DNS Provider（无账号上下文），分层：RDAP → WHOIS → HTTP API → 第三方
    - **适配器动态注册**：DNS 提供商通过 `lib/dns/providers/index.ts` 的 `whoisSchedulers` 数组自动汇集，WHOIS 模块启动时遍历注册，新增提供商只需在数组追加，无需改动 WHOIS 模块。

### DNS 解析器
1. 解析器架构（`server/src/lib/dns/resolver/`）
    - 支持三种解析方式：明文 DNS（`plain-resolver.ts`）、DNS-over-HTTPS（`doh-resolver.ts`）、DNS-over-TLS（`dot-resolver.ts`）。
    - 统一解析器入口（`resolver.ts`）负责协调三种解析方式。
    - DNS 服务器列表（`servers.ts`）维护可用的 DNS 服务器。
    - 代理隧道（`proxy-tunnel.ts`）支持通过代理进行 DNS 查询。
    - 类型定义（`types.ts`）定义解析器相关的类型接口。

### 代理模块
1. HTTP 代理客户端（`server/src/lib/proxy-http.ts`）
    - 支持 SOCKS5 和 HTTP 代理。
    - 提供 `fetchWithFallback()` 函数，支持代理降级。
    - 代理配置从 `SettingsOperations` 获取，支持动态配置。
    - 依赖 `socks-proxy-agent` 和 `https-proxy-agent` 可选包。

### 应用初始化与生命周期
1. 启动流程（`server/src/app.ts`）
    - 加载环境变量 → 创建数据库连接 → DSM 初始化（Schema协调/迁移） → 检查系统初始化状态。
    - 已初始化模式：启动所有定时任务（域名同步、续期、WHOIS、故障转移、NS 监控、缓存刷新）。
    - 未初始化模式：仅开放初始化路由，每隔5秒检查初始化状态，初始化完成后自动启动所有服务。
    - WebSocket 服务随 HTTP 服务器一起初始化。
    - **系统状态统一由 `server/src/service/systemState.ts` 维护**，对外只暴露 `isSystemInitialized()`；禁止各模块自行判定初始化状态。
2. 数据库初始化状态判定（强制约束）
    - 状态必须为**三态**：`initialized`（users 表存在且有用户）、`uninitialized`（数据库可达但尚未初始化）、`unreachable`（连接或查询失败）。
    - **`unreachable` 绝不等同于 `uninitialized`**。数据库故障是故障，不是首次部署。判定函数（`isDbInitialized()`、`hasUsers()`）失败时必须**抛出异常**，严禁 `catch` 后返回 `false`。
    - 已初始化标记是**粘性**的：一旦确认 `initialized`，后续数据库抖动不得使其回退为未初始化状态，只能进入降级模式。
    - 该标记**必须持久化到磁盘**（默认 `data/.initialized`，可用 `HIDNS_INIT_MARKER` 覆盖），并在进程启动时立即读取。**禁止仅依赖内存状态**：否则进程重启且数据库恰好不可达时，初始化入口会被重新打开。若确需重新安装，由运维显式删除该标记文件。
    - 启动时若判定为 `unreachable`，必须进入**降级模式**（业务路由 503、初始化入口关闭）并周期性重连，恢复后重新判定；**不得**打印“Running in initialization mode”。
3. 数据库连接生命周期（强制约束）
    - 连接管理器 `server/src/db/dal/connection.ts` 为单例。**`disconnect()` 不得销毁单例**：否则紧随其后的 `connect()` 会落在被遗弃的旧实例上，而模块级 `getConnection()` 会取到一个未连接的新管理器，造成“重连成功”日志与不可用连接态并存。
    - 每次 `connect()` 调用必须在入口**无条件重置** `reconnectAttempts`。仅在成功时清零会导致某轮重试耗尽后 `while(count >= max)` 恒假、后续重连直接失败。
    - 重连必须带指数退避与上限，且退避需封顶；健康检查发现连接不健康时须能持续重试，不得因一次失败而永久放弃。
4. 初始化路由的开放边界（强制约束）
    - `/api/init` 在系统**未初始化**时开放，用于完成首次安装。
    - **系统一旦完成初始化，状态变更类端点（`/database`、`/admin`）必须永久关闭**（返回 403）；只读且已脱敏的端点（`/status`、`/db-config`）可保留用于状态探测。
    - 未初始化模式下，除 `/api/init` 与明确公开的路由（如 `/api/rdap`）外，**所有 `/api/*` 路由一律返回 503**。实现必须采用「默认拒绝 + 显式豁免」，**禁止**逐个枚举受保护前缀。
    - 初始化端点必须配置请求频率限制（rateLimit）。
    - 已知遗留风险：未初始化实例若暴露于网络，首个访问者可抢先创建管理员。生产部署应在初始化完成前限制网络可达性，或引入安装令牌。
5. 优雅关闭
    - 监听 SIGTERM 和 SIGINT 信号。
    - 关闭顺序：停止定时任务 → 关闭 WebSocket → 断开数据库连接 → 关闭 HTTP 服务器。

### 工具模块
1. 工具函数（`server/src/utils/`）
    - `http.ts`：HTTP 请求/响应工具函数（`sendSuccess`、`sendError`、`getString`、`parseInteger`、`parsePagination` 等）。
    - `response.ts`：响应格式化工具。
    - `roles.ts`：角色管理工具（`isAdmin`、`normalizeRole` 等）。
    - `validation.ts`：参数验证工具。

### 客户端架构

> 本节描述的是**重构后**的前端；旧实现（TDesign、i18next、`pages/`、`contexts/`、`api/` 旧封装）已于 2026-10 全部删除，仓库内不再保留。

1. 技术栈
    - React 19 + TypeScript（Vite 8 构建，路由级代码拆分）。
    - React Router 7（`BrowserRouter` + 嵌套 `<Route element>` 守卫）。
    - TanStack Query v5：所有服务端状态走 query/mutation，`queryKey` 由 feature 自己定义。
    - Tailwind CSS 3.4 + shadcn 风格 `ui/` 原语（Radix + CVA + tailwind-merge）。
    - 表单：React Hook Form + zod（登录页等复杂表单）；简单表单用受控组件。
    - 图标：lucide-react。**不再使用任何 UI 组件库的图标集。**
    - 语言：单一简体中文，文案集中在 `copy/zh-CN.ts` 与各 feature 内部；**不再有 i18n 框架**。

2. 目录结构（`client/src/`）
    ```
    client/src/
    ├── app/                 # 应用外壳与横切能力
    │   ├── app-shell.tsx        # 侧边栏 + 顶栏 + 主题切换 + 背景偏好注入
    │   ├── protected-shell.tsx  # /dash/* 守卫（会话校验 → 外壳 → 子路由）
    │   ├── require-admin.tsx    # 管理页守卫（useSession + isAdminUser 唯一口径）
    │   ├── realtime.tsx         # 全局单连接 WebSocket：事件 → queryKey 失效表
    │   └── nav.ts               # 导航分组与图标
    ├── ui/                  # 设计系统原语（Button/Input/Card/Dialog/Table/Select/Alert…）+ tokens.css
    ├── lib/                 # http.ts（类型化 fetch + ensureOk/expectData/requestRaw）、theme.tsx、format.ts
    ├── copy/                # 中文文案（单一 zh-CN）
    ├── features/<domain>/   # 业务模块（唯一允许放页面代码的地方）
    │   ├── api.ts               # 该模块的端点封装（统一 lib/http）
    │   ├── use-<domain>.ts      # 该模块的 query/mutation hooks（多数模块已有；纯展示页可无）
    │   ├── <domain>-page.tsx    # 页面
    │   └── __tests__/           # 该模块用例（不是每个模块都有，覆盖率按页面补）
    ├── components/          # 仅剩 ErrorBoundary（全局 Toast 通道已移除，页面统一用内联提示）
    ├── types/               # 全局类型声明（仅剩极少量 ambient 类型）
    ├── utils/               # 无业务语义的纯函数（如 rsaEncrypt，必须走 lib/http）
    ├── styles/              # 仅 globals.css（Tailwind 入口 + 历史 CSS；设计 token 在 ui/tokens.css）
    └── test/                # 测试环境 setup（jsdom 补丁、全局 mock）
    ```

3. 模块化约束（强制）
    - **页面代码只能写在 `features/<domain>/`**，禁止新增 `pages/`、`contexts/`、`api/` 目录。
    - 跨模块复用只允许通过**显式导出**（例如 records 页复用 `useDomainAccounts`）；禁止深路径相互 import 内部实现。
    - 每个 feature 自持 `api.ts` + `use-*.ts` + 页面 + 用例，四件套齐全才算完成。
    - 路由在 `App.tsx` 一处集中声明：`/dash/*` 全部在 `ProtectedShell` 内，管理页再套 `RequireAdmin`。

4. 权限与按钮可见性（强制）
    - **能隐藏就不要让用户点出 403**：后端已能判定的权限，必须在响应里透出，前端据此隐藏按钮，而不是依赖错误提示。
    - 域名域：`GET /api/domains`、`GET /api/domains/:id` 返回 **`can_write`**（口径 = `resolveDomainAccess().canWrite`，含团队规则与子域白名单）。前端在 `can_write === false` 时隐藏「启用/禁用、编辑备注、删除」并显示「只读」徽标；「记录」入口是只读，保留。
    - 账号域：`POST /api/accounts` 是管理员动作（后端 `isAdmin` 判定），前端用 `isAdminUser(user)` 隐藏「新建账户」；同理「新增域名」要求对账号有管理权，普通用户不显示入口。
    - 站点管理页（用户/审计/工作流/系统设置/MCP 配置）统一在 `RequireAdmin` 下，个人资源页（令牌、个人密钥、2FA）不套。
    - 新增需要权限的端点时：先在后端判定，再把判定结果透出（`can_*` 字段），最后前端按字段隐藏——三步缺一不可。

5. 域名虚拟分组
    - 列表支持 `grouped=true`：后端按**可注册域**（`getRootDomain`）聚合，在返回的 `list` 里插入 `{ _type: 'group_header', id: -父域id, groupName, childIds }`，子域行带 `_groupParentId`。
    - 可注册域用**公共后缀表**计算，不能取最后两段：`cc.cd`、`dpdns.org`、`us.kg` 等是多段公共后缀（`foo.cc.cd` 的可注册域就是自身）。
    - 后缀集合的**真值在 DB 表 `public_suffixes`**：`service/publicSuffixJob.ts` 启动时载入内存快照，并异步从 `PUBLIC_SUFFIX_LIST_URL`（默认 publicsuffix.org 的 DAT）下拉，之后每 `PUBLIC_SUFFIX_REFRESH_DAYS`（默认 7 天）刷新；下载失败/响应异常**不入库**、继续用现有集合（域名分组不能因一次网络抖动而崩）。
    - **内嵌快照** `server/src/data/public-suffix-list.dat`（publicsuffix.org 的 DAT，含 ICANN/PRIVATE 两段，MPL-2.0，见 docs/THIRD_PARTY_NOTICES.md）：全新实例或内网首次启动没有网络时也能算对根域。
    - 代码里的内置清单（常见二级后缀 + WHOIS 注册表 suffix）只用于**首次播种**与快照缺失时的兜底，不是运行时真值；新增 TLD 不必发版。
    - **IDN**：PSL 里 `公司.cn` 这类 Unicode 后缀在解析时转 Punycode；域名比较统一用 `xn--` 形式，返回给前端才转 Unicode。
    - PSL 的 `*.ck` 通配按「任意 `x.ck` 都是公共后缀」处理；`!` 例外规则跳过（宁可少切碎可注册域）。
    - 分组模式由**用户开关**决定（`virtual_groups`）：
        - `virtual_groups=true`（界面默认「总是分组」）：无条件按可注册域造组，父域未添加也虚拟出组头；组头 id 由组名哈希派生（`-(1000000+hash)`），与 `-父域id` 不冲突。
        - `virtual_groups=false`（界面「仅父域存在」）：只有父域在列表里才成组；父域不在时子域各自独立。
    - 只有一个域名命中某个可注册域、且它就是该域本身（没有子域）时不成组，保持独立行。
    - 前端默认开启分组：组头可折叠，展开才渲染子域行；`grouped=true` 时 `pageSize` 按「块（组或单域）」计数。
    - 虚拟组（父域未添加）在组头显示 **「父域未添加」** 徽标（`parentPresent=false`），提示父域自身的到期/WHOIS 信息不可用。

6. 域名列表的两套响应契约（强制，不得混用）
    - **UI**（浏览器会话）：`{ list, total, page, pageSize, totalPages }`，域名返回 **Unicode**，行带 `can_write`；分组时附 `_type/groupName/parentPresent/_groupParentId`。
    - **API**（API Token 或 `format=array`）：**裸数组**，域名保持 **Punycode** 并附 `display_name`，供 ddns-go / certd 等外部适配器。
    - 判定集中在 `routes/domains.ts` 的 `resolveDomainListShape()`（有单测）；新增查询参数不得改变这个分支。
    - **DDNS-Go 兼容不抛弃**：认证 Bearer Token、列表裸数组、`allowed_domains` 空数组不限制、记录写接口均已覆盖；真要弃用须先给 `X-HiDNS-Compat` 弃用期并在 api.md/CHANGELOG 双处公告（见 docs/development/domain-list-api-format.md）。
    - 新增依赖前先看 `ui/` 与 `lib/` 是否已覆盖；**禁止再引入整包 UI 框架或 i18n 框架**。

4. 数据层约定
    - 统一信封 `{ code, data, msg }`，`code === 0` 表示成功；`lib/http.ts` 对缺失 `code` 的响应直接抛错。
    - 写操作用 `ensureOk(envelope)` 判 `code`，避免「失败却提示成功」。
    - 少数按协议返回裸 JSON 的端点（如 `/mcp/oauth/authorize`）走 `requestRaw`，由调用方判 `ok`。
    - 实时更新：`app/realtime.tsx` 维护「事件 → queryKey 前缀」映射表，新增后端事件时必须同步补表。

5. 主题与背景
    - `lib/theme.tsx` 的 `ThemeProvider` 是唯一来源，包裹整个应用（含 `/login`、`/setup`、`/oauth/*`）。
    - 存储键 `theme`，取值 `light` / `dark` / `auto`（`auto` = 跟随系统）；`index.html` 内联脚本在首屏前应用，避免深色用户白闪。
    - 背景图默认取第三方随机图源（`t.alcy.cc/moez`）：控制台经 `html[data-surface='console']` 加强蒙层当底纹，公开页按黄金分割分栏展示。
    - **自托管/内网**：构建期设 `VITE_DEFAULT_BACKGROUND=none` 即可完全不请求第三方图源（`lib/theme.tsx` 与落地页共用同一开关）；运行期用户可在「设置 → 偏好 → 背景图地址」填 `none` 关闭或填自定义 http(s) 地址覆盖（服务端只存字符串，前端做协议白名单 + 转义，防 CSS 注入）。

6. 门禁（客户端与服务端，两者都必须跑）
    ```bash
    # 客户端（子 shell，避免连续 cd 出错）
    (cd client && npx tsc -b && npx vitest run && npx vite build && npx eslint .)
    # 服务端
    (cd server && npx tsc --noEmit && npx vitest run && npx eslint . --max-warnings=0)
    ```
    - 客户端 `tsconfig.json` 为 solution 式，`tsc --noEmit` **不会检查任何文件**，必须用 `tsc -b`。
    - 历史上的 4 个腐化集成用例（`tests/{db-migration,proxy-config,ns-monitor,domain-filter}.test.ts`）已于 2026-10-23 **删除**（引用了已删除的 `src/db/init-dsm`、`/src/db/business-adapter`，fixture 绑定旧 schema），`exclude` 里不再有它们；替代覆盖为 `tests/db-bootstrap.test.ts`（新库建表 + `users.password_hash`）与 `src/utils/domain-classify.test.ts`（顶域/子域分类）。写新的集成用例请用 `tests/helpers/test-db.ts`（临时 sqlite + DSM 建表 + 自动清理）。
    - `*.test.node.ts` 用 `node:test` 编写，由 `pnpm --filter dnsmgr-server run test:node` 执行，不进 vitest。

### 外部应用集成 API

> **API 文档是第一权威**：所有 API 端点、参数、返回值、鉴权方式以 `docs/api.md` 为准。新增或修改 API 后**必须同步更新 `docs/api.md`**，否则视为未完成。

第三方工具（如 DDNS-Go、acme.sh 等）可通过 **API Token** 认证调用 HiDNS 的域名解析管理接口。

#### 认证方式

使用 `Authorization: Bearer <API_Token>` 请求头进行认证。API Token 需在系统管理页预先创建，并分配域名/服务权限。

```http
Authorization: Bearer dnsmgr_xxxxxxxxxxxx
```

#### 基础 URL

```
http(s)://<HiDNS部署地址>/api
```

#### 通用响应格式

所有 API 返回统一格式：

```json
{
  "code": 0,
  "data": "...",
  "msg": "success"
}
```

- `code === 0`：请求成功
- `code !== 0`：请求失败，`msg` 包含错误描述

#### 外部适配器注意事项

1. **分页安全限制**：全量遍历域名/记录时，最多遍历 10 页（1000 条），避免过度请求
2. **幂等操作**：创建记录前通过 `subdomain` + `type` 查询现有记录，存在则更新、不存在则创建
3. **Token 权限**：API Token 需具有目标域名的读写权限，否则返回 403
4. **IDN 域名**：查询时使用 Punycode（ASCII）编码的域名，返回数据中包含 `display_name` 字段为 Unicode 形式
5. **API 文档同步**：新增、修改或废弃任意 API 端点后，**必须**同步编辑 `docs/api.md`，确保文档与实际行为一致

#### 调用示例

**DDNS-Go 适配器**参考实现：[tmp_ddns-go/dns/hipmdnsmgr.go](file:///c:/Users/HINS/Documents/Trae/DNSMgr-1/tmp_ddns-go/dns/hipmdnsmgr.go)

```go
// 简化示例
func updateDDNS(apiToken, baseURL, domain, subDomain, ip string) error {
    // 1. 查找域名 ID
    domainID, err := findDomain(baseURL, apiToken, domain)
    if err != nil {
        return err
    }
    
    // 2. 查找现有记录
    record, err := findRecord(baseURL, apiToken, domainID, subDomain, "A")
    if err != nil {
        return err
    }
    
    // 3. 更新或创建
    if record != nil {
        return updateRecord(baseURL, apiToken, domainID, record.ID, subDomain, "A", ip, 600)
    }
    return createRecord(baseURL, apiToken, domainID, subDomain, "A", ip, 600)
}
```

### 安全规范
1. 认证方式
    - JWT Token（用户登录，有效期7天），签名密钥为 `JWT_SECRET + runtime_secret`。
    - API Token（程序化访问，支持域名/服务/时间范围限制）。
    - WebAuthn 无密码认证（通过 @simplewebauthn/server）。
    - TOTP 双因素认证（通过 `otplib`，见 `server/src/service/totp.ts`）。
    - OAuth2/OIDC 单点登录。
2. 权限模型
    - 三种角色：普通用户、管理员、超级管理员。
    - API Token 支持细粒度权限控制（服务权限、域名权限）。
3. 安全中间件
    - 请求频率限制（rateLimit）。
    - 安全 HTTP 头（CSP、X-Frame-Options 等）。
    - 运行时密钥轮换（SecretOperations）。
    - 安全策略管理（密码长度、会话超时、登录尝试限制）。
    - 登录限制（IP/设备信任）。

## 版本发布流程

### 版本号规范
- 遵循语义化版本（SemVer）：`主版本.次版本.修订号`
- 主版本：不兼容的 API 修改
- 次版本：向下兼容的功能新增
- 修订号：向下兼容的问题修正

### 发布步骤
1. **确认所有更改已提交**：`git status` 确保工作区干净
2. **更新 CHANGELOG.md**：在 `docs/CHANGELOG.md` 追加当前版本条目，包含新功能、Bug 修复、优化三个分类
3. **更新版本号**：修改根目录、`server/`、`client/` 三个 `package.json` 的 `version` 字段
4. **提交版本发布**：`git add -A` → `git commit -m "chore: release version X.Y.Z"`（提交信息体包含完整 changelog）
5. **打 Tag**：`git tag vX.Y.Z`
6. **推送到远程**：`git push && git push --tags`
7. **触发 Release Workflow**：在 GitHub Actions 中手动触发 `release.yml`，传入版本号
8. **验证 Release**：确认 Release 页面显示正确的 changelog 内容、PR 列表、Top 10 Commit

## 提交信息格式

### 第一行：主题（简短描述）
- 格式：`<type>(<scope>): <简短描述>`
- `type`：`feat`（新功能）、`fix`（修复）、`refactor`（重构）、`docs`（文档）、`style`（样式）、`chore`（杂项）、`perf`（性能）、`test`（测试）、`build`（构建/打包）、`ci`（CI 配置）、`revert`（回滚）
- `scope`（可选）：影响范围，如 `dpdns_reverse`、`components`、`server`、`client`
- 简短描述：50 字以内，中文或英文，首字母小写（英文），不加句号
- 示例：`fix(dpdns_reverse): 修正日期解析格式为MySQL兼容格式`

### 第二行起：详细描述
每条描述占一行，用缩进分段，格式如下：

```
详细描述：
  部分关键变更：[变更1], [变更2], ...
  修复问题：[问题1], [问题2], ...
  新增功能：[功能1], [功能2], ...
  部分关键实现：[实现1], [实现2], ...
  优化：[优化1], [优化2], ...
```

### 完整示例

```
feat: add domain renewal and dns account filtering, optimize provider display

详细描述：
  部分关键变更：[添加provider capabilities的dns和renewal字段], [按purpose筛选账号接口], [替换i18n钩子为自定义上下文], [更新dpdns反向代理路由和认证头], [域名列表和续费页优化账号展示]
  修复问题：[修复provider类型未本地化显示的问题], [修正dpdns路由名称不匹配的问题]
  新增功能：[按用途筛选DNS账号接口], [续费专用账号筛选功能], [反向代理dpdns提供商支持]
  优化：[更新认证请求头绕过风控], [优化查询key缓存区分不同场景的账号列表]
```

```
fix(dpdns_reverse): 修正日期解析格式为MySQL兼容格式

详细描述：
  部分关键变更：[将parseDpdnsDate的日期输出格式从ISO 8601改为MySQL/SQLite兼容格式]
  修复问题：[MySQL DATETIME列无法写入ISO 8601格式的日期字符串]
```

## 待办