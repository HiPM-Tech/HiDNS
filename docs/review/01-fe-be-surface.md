# 前后端接口面梳理（01-fe-be-surface）

> 范围：`client/src/api/*.ts` 的全部调用 ↔ `server/src/routes/*.ts` + `server/src/app.ts` 注册的全部路由。
> 方法：脚本解析两侧（前端抓 `api.<verb>(<path>`，服务端按 `app.ts` 挂载表拼全路径），再做 method + 路径形状比对。
> 统计口径：前端 **174** 条唯一 (method, path)；服务端 **218** 条唯一 (method, path)。
> 只读评审，未运行任何会写文件的命令。

---

## 一、结论摘要

1. **api 层这一面对齐得不错**：174 条前端调用里，只有 **6 条**在服务端找不到对应路由，且都集中在 failover / ns-monitor / mcp audit-stats 三处，没有一条在主路径上。
2. **真正的问题不在 api 层，在"绕过 api 层"**。把页面里手写的 `fetch` 也算进"前端真实调用"，会多出 **5 条**对不上的路径，其中 3 条服务端根本不存在。最严重的一处是 `pages/Security.tsx`：8 处裸 `fetch` + 手工拼 `Authorization: Bearer ${localStorage.getItem('token')}`，而全仓 **没有任何一处 `localStorage.setItem('token')`**，鉴权早已改成 httpOnly cookie（`client/src/api/client.ts:17` 注释与 `:20-24` 拦截器）。结果是这批请求全部带 `Bearer null`，会话管理与 2FA/passkey 状态整块静默失效（失败分支只有 `if (response.ok)`，不 ok 就什么都不做）。
3. **服务端有 48 条路由前端零调用**。分流后：MCP/外部集成 14 条（合理）、审计 6 条（文档化但无 UI）、实际在用但绕过 api 层 6 条、**确实无消费方 22 条**。另有 5 条被同名路由遮蔽、永远不可达（不在 48 条内，因路径去重被合并了）。其中 `routes/securityPolicy.ts` 整个文件的 `/policy`、`/password-strength`、`/trusted-devices` 被 `routes/security.ts` 的同名路由**完全遮蔽**（`app.ts:509-510` 顺序决定），永远不可达。
4. **没有共享层**：`RecordType`、`RoleLevel/ROLE_*`、域名根域解析三处都是前后端各一份，靠注释「保持同步」约束，没有任何编译期保证。

---

## 二、端点对照表

### 2.1 前端调用 → 服务端不存在 / 不匹配（6 条，api 层内）

| # | 前端位置 | 方法 + 路径 | 服务端实况 | 结论 |
|---|---|---|---|---|
| 1-4 | `client/src/api/auth.ts:33-36` | `GET/POST/PUT/DELETE /api/domains/:id/failover` | 无。`grep -rn "failover" server/src/routes/*.ts` 只命中 `servicemonitor.ts`（type=`dns_failover`），没有任何 `router.*('...failover')` | **死代码**：`getFailover/createFailover/updateFailover/deleteFailover` 全仓零调用点 |
| 5-7 | `client/src/api/domains.ts:36-38` | `GET/POST/DELETE /api/domains/:id/failover` | 同上 | **死代码**：与上表重复定义同一组端点，两处都零调用 |
| 8 | `client/src/api/mcp.ts:114` | `GET /api/mcp/audit-stats/:userId` | 不存在。`mcp-audit.ts:47` 只有 `router.get('/')`，被 `app.ts:531` 挂到 `/api/mcp/audit-stats` 后只匹配 `/api/mcp/audit-stats` 本身，`/:userId` 落到 404 | **双向死**：前端 `getAuditStats` 零调用点，服务端也没有对应子路由 |
| 9 | `client/src/api/ns-monitor.ts:11` | `GET /api/ns-monitor/domain/:domainId` | 不存在。`ns-monitor.ts` 只有 `/`、`/available-domains`、`/user/prefs`、`/check`、`/resolve-ns`、`/:id` | **双向死**：`getByDomain` 零调用点 |

> 注：`mcp-audit.ts` 的 `router.get('/')` 被 `app.ts:530-531` 同时挂到 `/api/mcp/audit-logs` 和 `/api/mcp/audit-stats` 两个前缀，导致「查审计日志」这一条 handler 有两个入口，其中 `/audit-stats` 这个入口没有语义、只挡住了一个本该是 `/audit-stats/:userId` 的位置。

### 2.2 前端调用 → 服务端不存在（api 层外，页面手写 fetch/axios，共 5 条）

| # | 前端位置 | 方法 + 路径 | 服务端实况 | 影响 |
|---|---|---|---|---|
| 1 | `client/src/pages/Security.tsx:120` | `GET /api/security/sessions` | **不存在**。`grep -rn "sessions" server/src/routes/ server/src/app.ts` 零命中 | 会话列表恒为空（`if (response.ok)` 不成立 → 静默） |
| 2 | `client/src/pages/Security.tsx:225` | `DELETE /api/security/sessions/:sessionId` | **不存在** | 「下线单个会话」按钮永远无效 |
| 3 | `client/src/pages/Security.tsx:246` | `POST /api/security/sessions/logout-others` | **不存在** | 「下线其它会话」永远无效 |
| 4 | `client/src/pages/Security.tsx:134` | `GET /api/security/2fa/status` | 路径写错。真实路由是 `security.ts:80` 的 `/2fa-status`（无中间斜杠） | 404 → 2FA 状态恒显示「未启用」 |
| 5 | `client/src/pages/Security.tsx:138` | `GET /api/webauthn/credentials` | 路径写错。真实挂载是 `app.ts:515 app.use('/api/auth/webauthn', ...)`，即 `/api/auth/webauthn/credentials` | 404 → passkey 列表恒为空 |

> 这 5 条**不会出现在任何 api 层审查里**，因为它们绕过了 `client/src/api/`。

### 2.3 服务端存在、前端未调用（48 条，已分流）

#### A. 实际在用，只是没走 api 层（6 条）

| 服务端位置 | 路由 | 谁在用 |
|---|---|---|
| `server/src/routes/auth.ts:461` | `GET /api/auth/public-key` | `client/src/utils/rsaEncrypt.ts:18` 裸 `fetch` |
| `server/src/routes/providers.ts:20` | `GET /api/providers/:type/icon` | `client/src/components/ProviderIcon.tsx:15` 拼 `<img src>` |
| `server/src/routes/providers.ts:99` | `GET /api/providers/:type/renewable-domains` | `client/src/pages/domains/DomainRenewalTab.tsx:62` 用 `api.get` 直连 |
| `server/src/routes/security.ts:163` | `POST /api/security/2fa/setup` | `Security.tsx:170` 裸 `fetch` |
| `server/src/routes/security.ts:183` | `POST /api/security/2fa/enable` | `Security.tsx:193` 裸 `fetch` |
| `server/src/routes/security.ts:220` | `POST /api/security/2fa/disable` | `Security.tsx:270` 裸 `fetch` |

#### B. MCP / 外部集成用（14 条，合理保留）

| 服务端位置 | 路由 | 用途 |
|---|---|---|
| `mcp-config.ts:64/241/331/441` | `GET /api/mcp/.well-known/{jwks.json,oauth-protected-resource,oauth-authorization-server,mcp.json}` | 标准发现端点，给外部 MCP 客户端 |
| `mcp-oauth.ts:501/617/926/1000` | `POST /api/mcp/oauth/{register,token,introspect,revoke}` | OAuth 2.1 标准端点 |
| `mcp-oauth.ts:318` | `GET /api/mcp/oauth/authorize` | 浏览器跳转式授权入口 |
| `mcp-protocol.ts:369/372/373` | `POST /api/mcp`、`GET/POST /api/mcp/sse` | MCP Streamable HTTP / SSE |
| `rdap.ts:211/296` | `GET /api/rdap/domain/:domain`、`GET /api/rdap/help` | 公开 RDAP（`docs/api.md` §RDAP） |

#### C. 文档化的管理接口，但没有 UI 消费方（6 条）

| 服务端位置 | 路由 | 说明 |
|---|---|---|
| `audit.ts:85` | `GET /api/audit/logs` | `docs/api.md:701` 声明 `noTokenAuth('audit logs')` + adminOnly，允许 Token 调用 → 外部集成面 |
| `audit.ts:131/178` | `GET /api/audit/export/{csv,json}` | 同上 |
| `audit.ts:216/253/290` | `GET /api/audit/{anomalies,stats,time-distribution}/:userId` | 同上 |

> 对照：`pages/Audit.tsx:7` 只 import 了 `logsApi, mcpApi`，走的是 `/api/logs`（`app.ts:580` 内联）与 `/api/mcp/audit-logs`。审计页面的导出、异常检测、时间分布三块能力没有任何前端入口。

#### D. 被遮蔽 / 重复注册，永远不可达（5 条，额外发现，不计入上面 48 条）

| 服务端位置 | 路由 | 为什么不可达 |
|---|---|---|
| `securityPolicy.ts:38` | `GET /api/security/policy` | `app.ts:509` 先挂 `securityRouter`，`security.ts:13` 已有同名路由 → 先匹配即返回 |
| `securityPolicy.ts:80` | `PUT /api/security/policy` | 同上，被 `security.ts:24` 遮蔽 |
| `securityPolicy.ts:105` | `POST /api/security/password-strength` | 被 `security.ts:36` 遮蔽 |
| `securityPolicy.ts:164` | `GET /api/security/trusted-devices` | 被 `security.ts:260` 遮蔽 |
| `securityPolicy.ts:187` | `DELETE /api/security/trusted-devices/:id` | 被 `security.ts:272` 遮蔽 |

> `securityPolicy.ts` 里**只有** `/2fa/requirement`（:137）与 `/check-device`（:210）是独有且可达的，其余 5 条是纯冗余。两个 router 都挂在 `/api/security`（`app.ts:509-510`）。

#### E. 确实没有消费方（22 条，可考虑下线或补 UI）

| 服务端位置 | 路由 | 备注 |
|---|---|---|
| `security.ts:36` | `POST /api/security/password-strength` | 前端改密码在 `Security.tsx`/`Settings.tsx` 本地算强度 |
| `security.ts:52` | `POST /api/security/validate-password` | 同上 |
| `security.ts:68` | `GET /api/security/requires-2fa` | 无前端入口 |
| `security.ts:80` | `GET /api/security/2fa-status` | **前端想调但路径写错**（见 2.2 #4） |
| `security.ts:260/272/304` | `GET /api/security/trusted-devices`、`DELETE .../:deviceId`、`DELETE ...` | 信任设备管理无 UI |
| `security.ts:316` | `POST /api/security/user-require-2fa` | 与 `/users/:userId/require-2fa`（:103/:131，前端在用）重复 |
| `securityPolicy.ts:137/210` | `GET /api/security/2fa/requirement`、`POST /api/security/check-device` | 可达但无 UI |
| `domains.ts:782` | `POST /api/domains/sync` | 无 UI 触发（只有定时任务调 service） |
| `domains.ts:1354` | `POST /api/domains/:id/whois` | 前端用的是 `GET /api/domains/whois`（`domains.ts:47`） |
| `domains.ts:1756` | `POST /api/domains/renewable-domains/sync` | 无 UI |
| `emailTemplates.ts:138/185` | `POST /api/domains/email-templates/:id/{check-conflicts,apply}` | `MailSetupModal.tsx` 只用了 list/get/preview |
| `records.ts:396` | `GET /api/domains/:domainId/records/:recordId` | 前端只用 list |
| `resource-monitor.ts:27` | `POST /api/resource-monitor/prune` | 运维手动接口，无 UI |
| `system.ts:45` | `GET /api/system/version` | `About.tsx:93` 用的是 `/system/info` 里的 version 字段 |
| `teams.ts:512` | `PUT /api/teams/:id/members/:userId` | 改成员角色无 UI（`teamsApi` 无对应方法） |
| `teams.ts:770` | `PUT /api/teams/:id/domain-permissions/:permissionId` | 改域名权限无 UI |
| `mcp-config.ts:158` | `POST /api/mcp/config` | 源码自述 "PUT alias for frontend compatibility"（`mcp-config.ts:177`），前端只用 PUT |
| `mcp-audit.ts:47` | `GET /api/mcp/audit-stats` | 错误挂载产物，语义重复 |

### 2.4 api 层方法零调用点（20 个）

`tunnelsApi.getConfig` / `tunnelsApi.updateConfig` / `authApi.{getFailover,createFailover,updateFailover,deleteFailover}` / `domainsApi.{getFailover,saveFailover,deleteFailover}` / `domainRenewalApi.getWhois` / `mcpApi.{getAuditStats,exportAuditLogs}` / `nsMonitorApi.{get,getByDomain}` / `serviceMonitorApi.{get,getChildren,getStats}` / `teamsApi.get` / `workflowsApi.{get,test}`。

> 其中 failover 那 7 个不但没人调，服务端也没有对应路由；`getByDomain`、`getAuditStats` 同样双向缺失。其余是「服务端有、前端封了但没用」。

---

## 三、耦合问题（带证据）

### 3.1 页面内直接 fetch —— 8 处，全部在 `pages/Security.tsx`

```
Security.tsx:120   const response = await fetch('/api/security/sessions', {
Security.tsx:134   const totpResponse = await fetch('/api/security/2fa/status', {
Security.tsx:138   const webauthnResponse = await fetch('/api/webauthn/credentials', {
Security.tsx:170   const response = await fetch('/api/security/2fa/setup', {
Security.tsx:193   const response = await fetch('/api/security/2fa/enable', {
Security.tsx:225   const response = await fetch(`/api/security/sessions/${sessionId}`, {
Security.tsx:246   const response = await fetch('/api/security/sessions/logout-others', {
Security.tsx:270   const response = await fetch('/api/security/2fa/disable', {
```

违反 `root.ai.md:644`「`api/`：所有 API 调用必须封装在这里，禁止在组件中直接使用 fetch/axios」与 `root.ai.md:648`。

**同一个文件里已经 import 了 `authApi`**（`Security.tsx:103` 用 `authApi.webauthnDeleteCred`），说明这不是历史遗留的写法差异，而是新老两套混用。

### 3.2 鉴权头与 `api/client.ts` 的鉴权模型冲突（同 8 处）

```
Security.tsx:121   headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
client/src/api/client.ts:17   withCredentials: true, // Required for httpOnly cookies
client/src/api/client.ts:20-24  // Token is now stored in httpOnly cookie, automatically sent by browser
                                // No need to manually add Authorization header for most requests
```

全仓 `grep -rn "localStorage.setItem('token')"` **零命中**，`getItem('token')` 只有 `Security.tsx` 那 8 行。即 `localStorage.getItem('token')` 恒为 `null`，请求头是 `Bearer null`。这一条与 2.2 的路径错误叠加，是 2FA/passkey/会话三块功能失效的直接原因。

### 3.3 页面内用 axios 直连并拼 URL

```
pages/domains/DomainRenewalTab.tsx:5   import { domainRenewalApi, accountsApi, api } from '../../api';
pages/domains/DomainRenewalTab.tsx:62  const res = await api.get(`/providers/${account.type}/renewable-domains`);
```

页面拿到了 axios 实例自己拼路径。对应的 `/providers/:type/renewable-domains` 在 `client/src/api/` 里没有任何封装（`api/providers.ts` 不存在），所以这条路只能这么写 —— 属于「缺封装 → 被迫越界」。

### 3.4 组件内拼 API URL

```
components/ProviderIcon.tsx:15   const iconUrl = `/api/providers/${normalizedType}/icon`;
```

`<img src>` 场景可以接受，但路径常量散在组件里，后端改前缀时不会有任何编译期报错。同类：`pages/McpManagement.tsx:491-555` 手写了 11 条 `/api/mcp/*` 文案（展示用，可接受）。

### 3.5 工具层直连

```
utils/rsaEncrypt.ts:18   const response = await fetch('/api/auth/public-key');
```

工具函数绕过 axios 实例，等于绕过了 `baseURL`（`client.ts:3-12` 支持 `VITE_API_URL`）、15s 超时、401 跳转拦截器。部署到子路径或独立 API 域名时会直接坏掉。

### 3.6 同一端点重复封装三份（failover）

| 位置 | 定义 |
|---|---|
| `client/src/api/auth.ts:33-36` | `getFailover/createFailover/updateFailover/deleteFailover` |
| `client/src/api/domains.ts:36-38` | `getFailover/saveFailover/deleteFailover` |
| `client/src/api/servicemonitor.ts:6` | `list({ type: 'dns_failover' })` ← 唯一真正在用的 |

三个模块对同一业务概念各有一套形状，且前两套指向的路由不存在。

### 3.7 api 模块归属混乱

```
client/src/api/index.ts:12   export { accountsApi, tunnelsApi } from './accounts';   // Tunnel 塞在 accounts.ts
client/src/api/auth.ts:33-36  failover 挂在 authApi 下，但路径是 /domains/:id/failover
client/src/api/records.ts:48-53  email-templates 挂在 recordsApi 下
```

`root.ai.md:520-538` 的目录约定列了 16 个 api 文件（`ns-monitor.ts` 重复列了两次，去重后 16 个），实际 `client/src/api/` 有 19 个：多出 `resource-monitor.ts`、`servicemonitor.ts`、`workflows.ts`。规范里也没有 `audit.ts`，审计页面走的是 `logsApi`。规范未同步。

### 3.8 类型定义靠手工镜像，没有单一真源

| 前端 | 后端 | 证据 |
|---|---|---|
| `client/src/types/record-types.ts:1-2` | `server/src/lib/dns/record-types.ts` | 注释原文：「mirrored from server/src/lib/dns/record-types.ts / Keep in sync when adding new record types」，`RecordType` 联合类型逐字复制 |
| `client/src/utils/roles.ts` | `server/src/utils/roles.ts` | `RoleLevel`/`ROLE_USER`/`ROLE_ADMIN`/`ROLE_SUPER` 完全重复；服务端多 `normalizeRole/isAtLeast/isSuper`，前端 `isAdmin(role?: number\|null)` 与服务端 `isAdmin(role: unknown)` 签名已分叉 |
| `client/src/utils/domain-utils.ts:3` | `server/src/service/whois/domain-utils.ts` | 注释原文：「与后端 server/src/service/whois/domain-utils.ts 保持同步」，`SPECIAL_SUFFIXES` 数组逐字复制 |
| `client/src/api/types.ts:175-204` | 无对应 | `FailoverConfig/FailoverStatus/FailoverData` 是纯前端臆造（服务端无此路由，见 2.1） |

### 3.9 客户端内部也有重复工具

`client/src/utils/formHelpers.ts` 与 `client/src/utils/typeConverters.ts` 都导出 `toBoolean/toString/toNumber`（`typeConverters.ts:11` `toBoolean` 与 `formHelpers.ts` 同名同义）。`root.ai.md:671` 只认 `formHelpers.ts`。

### 3.10 注释/导出已腐化

```
client/src/api/index.ts:40-41
  // Legacy API exports (deprecated - will be removed after full migration)
  // These are kept for backward compatibility with existing imports
```

后面没有任何代码，是空段。

---

## 四、抽离方向

### 4.1 建共享包（推荐）

`pnpm-workspace.yaml` 已有 `server` / `client` / `e2e` 三个包，加一个 `packages/shared`（或 `shared/`）成本很低，且是唯一能真正消除 3.8 的办法。

**应共享（纯类型 / 纯常量 / 纯函数，零依赖）**

| 内容 | 现状 | 迁移后 |
|---|---|---|
| `RecordType` 与 `ValueType` | 两份逐字复制 | `@hidns/shared/dns/record-types` |
| `RoleLevel`、`ROLE_USER/ADMIN/SUPER`、`isAdmin/isAtLeast/normalizeRole` | 两份，签名已分叉 | `@hidns/shared/auth/roles` |
| `getRootDomain` / `SPECIAL_SUFFIXES` | 两份逐字复制 | `@hidns/shared/dns/domain` |
| `ApiResponse<T>`（`client/src/api/client.ts:46-50`）与 `server/src/utils/http.ts` 的 sendSuccess/sendError 形状 | 各写一份 | `@hidns/shared/http/envelope` |
| Provider 配置字段类型（`client/src/api/types.ts:37-49` vs `server/src/lib/dns/providers/extra-types.ts:12-36`） | 两套形状 | `@hidns/shared/providers/fields` |
| Workflow action meta（`client/src/api/workflows.ts:4-35` vs `server/src/lib/dns/providers/extra-types.ts` + `workflow/meta`） | 前端自己抄了一份 `WorkflowActionParam` | `@hidns/shared/workflow/action-meta` |
| `NSMonitorConfig`、`MonitorType`（`ServiceMonitorTab.tsx:13` 手写联合类型） | 前后端各一份 | `@hidns/shared/monitor` |

**不该共享**：ORM 行类型（`server/src/types/*` 的 `Domain`/`DnsAccount` 带 `account_id`/`created_by` 等库字段），前端已经在 `api/types.ts` 里做了裁剪视图 —— 这层裁剪是对的，别合并。

### 4.2 把本文件的对照表变成 CI 守卫

在 `server` 侧加一个 vitest 用例（与 `providers/__tests__/layer-dependency.test.ts` 同风格）：
- 用本文件 §二 的解析逻辑扫 `client/src/api/*.ts` 的 `api.<verb>('<path>')`；
- 扫 `app.ts` 的挂载表 + `routes/*.ts` 的 `router.<verb>('<path>')`；
- 断言「前端集合 ⊆ 服务端集合」，失败时打印差集。
这能一次性堵住 2.1 的 6 条，且以后新增端点写错路径立刻红。**注意**：这个守卫覆盖不到 `Security.tsx` 那类裸 `fetch`，所以还需要下面一条。

### 4.3 禁止裸 fetch 的守卫

扫 `client/src/**/*.tsx?`（排除 `api/`）里匹配 `fetch('/api` 的行，断言为空；第三方域名（`About.tsx:69/85` 的 `api.github.com`）白名单放行。这一条能一次性把 3.1、3.5 归零。

### 4.4 api 模块合并 / 拆分

| 动作 | 对象 | 理由 |
|---|---|---|
| **拆出** | `tunnelsApi` 从 `accounts.ts` → `api/tunnels.ts` | 与 DNS 账号无业务关系（`index.ts:12` 现在的导出方式会误导调用方） |
| **拆出** | `email-templates` 从 `records.ts` → `api/email-templates.ts` | 服务端本来就是独立 router（`app.ts:502`），前端却混在 records 里 |
| **拆出** | failover 相关 7 个方法 | 服务端不存在，直接**删除**；若将来要恢复，应进 `api/domains.ts` 且路径与服务端同时落地 |
| **新增** | `api/providers.ts` | 收纳 `/providers/:type/{icon,renewable-domains}`，让 `DomainRenewalTab.tsx:62` 与 `ProviderIcon.tsx:15` 归位 |
| **新增** | `api/security.ts` | 收纳 `/security/*` 全部（含 2FA、信任设备、会话），让 `Security.tsx` 的 8 处裸 fetch 有家可回 |
| **合并** | `formHelpers.ts` + `typeConverters.ts` → 只留 `formHelpers.ts` | 同名同义函数两份（3.9） |
| **对齐** | `api/index.ts` 删掉 :40-41 的空 Legacy 段；把 `resource-monitor.ts`/`servicemonitor.ts`/`workflows.ts` 补进 `root.ai.md:520-538` 的目录树 | 现状：规范里 16 个文件，实际 19 个 |

### 4.5 服务端侧的对称清理

- 删 `routes/securityPolicy.ts` 里被遮蔽的 5 条（§2.3 D），只保留 `/2fa/requirement` 与 `/check-device`；或把两个 router 合并成一个，避免再出现「同前缀双注册」。
- 修 `app.ts:531` 的 `mcpRouter.use('/audit-stats', mcpAuditRouter)` —— 它把审计日志列表挂到了统计前缀下，同时让 `/audit-stats/:userId` 无法实现。
- `/api/logs` 直接写在 `app.ts:580`，与 `root.ai.md:361`「路由文件集中在 server/src/routes/」不符（`docs/api.md:714` 自己标了「内联路由」，属于已知但未收口）。
