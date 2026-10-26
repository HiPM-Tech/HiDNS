# API 路由架构

> 方法级契约（端点、参数、返回、鉴权细节）只存在于 [`docs/api.md`](../api.md)。本页讲**模块怎么挂、挂在哪、谁先把请求吃掉**——这三件事在 `api.md` 里看不到。

## 一、唯一注册点

业务路由的注册只有一个地方：`server/src/api/index.ts` 的 `buildApiModules()`。

- `app.ts` 只保留门禁、`/api/docs`、`apiLayer.mount(app)`，**禁止**直接 `app.use` 业务路由。
- 每个模块声明 `id / prefix / router / service? / middlewares? / exemptFromInitGate? / closedStateProbes? / description`。
- `api/registry.ts` 在启动期 fail-fast 校验：`id` 唯一、`prefix` 唯一（按小写 + 参数名折叠归一化比较）、前缀格式合法、`closedStateProbes` 必须落在自身前缀下、`description` 必填。
- **顺序即匹配顺序**。静态子路径必须排在父前缀之前，否则会被父路由永久遮蔽（历史事故：`/api/domains/email-templates` 挂在 `/api/domains` 之后）。

## 二、模块清单（23 个，按挂载顺序）

| # | id | prefix | 服务归属 | 初始化门禁 | 额外中间件 | 守卫要点（模块内出现的中间件） |
|---|---|---|---|---|---|---|
| 1 | `init` | `/api/init` | — | **豁免**（`closedStateProbes`: `/api/init/status`、`/api/init/db-config`） | — | 端点自身守卫：初始化完成后 `/database`、`/admin` 永久 403 |
| 2 | `auth` | `/api/auth` | — | 受保护 | — | 公开 + `noTokenAuth`（敏感端点禁止 API Token） |
| 3 | `webauthn` | `/api/auth/webauthn` | — | 受保护 | — | 公开 + `authMiddleware`（**必须先于 `/api/auth` 之外匹配**，独立前缀） |
| 4 | `users` | `/api/users` | — | 受保护 | — | `authMiddleware` + `adminOnly` + `noTokenAuth` |
| 5 | `teams` | `/api/teams` | — | 受保护 | — | `authMiddleware` |
| 6 | `accounts` | `/api/accounts` | `dns` | 受保护 | — | `authMiddleware`；新建账号在 handler 内用 `isAdmin` 判定 |
| 7 | `domain-email-templates` | `/api/domains/email-templates` | `dns` | 受保护 | — | `authMiddleware`；当前全部为 GET |
| 8 | `domains` | `/api/domains` | `dns` | 受保护 | — | `authMiddleware`；写操作走 `canWrite` / 域名白名单 |
| 9 | `providers` | `/api/providers` | `dns` | 受保护 | — | `authMiddleware`；当前全部为 GET |
| 10 | `records` | `/api/domains/:domainId/records` | `dns` | 受保护 | — | `authMiddleware`；多数路由再叠 `requireTokenDomainPermission('domainId')` |
| 11 | `rdap` | `/api/rdap` | — | **豁免** | `rdapLimiter` | 公开（无需鉴权），单独限流 |
| 12 | `system` | `/api/system` | — | 受保护 | — | `authMiddleware` |
| 13 | `settings` | `/api/settings` | — | 受保护 | — | `authMiddleware` + `adminOnly` + `noTokenAuth` |
| 14 | `security` | `/api/security` | — | 受保护 | — | `authMiddleware` + `adminOnly` + `noTokenAuth` |
| 15 | `audit` | `/api/audit` | — | 受保护 | — | `authMiddleware` + `adminOnly` + `noTokenAuth` |
| 16 | `tokens` | `/api/tokens` | — | 受保护 | — | `authMiddleware` + `noTokenAuth`（令牌管理不能被令牌本身调用） |
| 17 | `ns-monitor` | `/api/ns-monitor` | `dns` | 受保护 | — | `authMiddleware` |
| 18 | `network` | `/api/network` | — | 受保护 | — | `authMiddleware` + `adminOnly` + `noTokenAuth` |
| 19 | `servicemonitor` | `/api/servicemonitor` | `dns` | 受保护 | — | `authMiddleware` |
| 20 | `resource-monitor` | `/api/resource-monitor` | — | 受保护 | — | `authMiddleware` + `adminOnly` |
| 21 | `workflows` | `/api/workflows` | `dns` | 受保护（**不在**豁免清单） | — | `authMiddleware` + `adminOnly`；写操作与手动运行额外要求 `requireJwtAuth` |
| 22 | `mcp` | `/api/mcp` | `mcp` | 受保护 | — | 模块内自管（API Key / OAuth），配置类端点 `authMiddleware` |
| 23 | `logs` | `/api/logs` | — | 受保护 | — | 管理员（`routes/modules/logs.ts`） |

> 守卫一列是「该模块源码里出现过这些中间件」，不是逐路由声明——哪条路由用什么，看路由文件或 `api.md`。

## 三、服务归属与 API Token（**当前实现**）

模块声明 `service: 'dns' | 'mcp'` 后，`api/mount.ts` 在挂载时插入服务级门禁：

- 只对 **`Authorization: Bearer`** 生效；无凭据 / 会话 JWT 直接放行，交给路由自身的 `authMiddleware`。
- 判定函数是 `service/token.ts` 的 `hasServicePermission(payload, service)`：`allowed_services` 为字符串数组时判断 `includes(service) || includes('*')`。
- 目前 `allowed_services` 只有**服务级**粒度（`['dns','mcp','*']`），没有操作级粒度；`AVAILABLE_SERVICES` 是工作流动作的命名空间，两回事，不要混用。

已知边界（不是文档遗漏，是当前实现）：

1. 携带 UserToken 的 **cookie** 请求不经过服务级门禁（门禁只读 Bearer 头），只经过路由的 `authMiddleware`。
2. 新增 `service: 'dns'` 模块时，服务级门禁自动生效，但**没有**操作级权限的自动扩展——操作级权限目前不存在。

## 四、初始化门禁（三态）

`api/init-gate.ts` 按系统状态分三种：

| 状态 | 行为 |
|---|---|
| `initialized` | 全部放行 |
| `uninitialized` | 只放行声明了 `exemptFromInitGate` 的模块（当前 `/api/init`、`/api/rdap`），其余 503 |
| `unreachable`（数据库不可达） | 初始化面一并关闭，只放行模块声明的 `closedStateProbes` 只读探测 |

路径比较**必须不区分大小写**（Express 路由本身大小写不敏感）。状态口径见 `root.ai.md` §应用初始化与生命周期 2/3/4，禁止在路由内自行判断。

## 五、已知的匹配陷阱

1. **静态子路径后置**：静态子路径（如 `/api/domains/email-templates`）挂在父前缀之后会被父路由吃掉。注册表只对「静态子路径晚于父前缀」发 debug 提示，不抛错——靠人守。
2. **参数段子路由不会遮蔽**：`/api/domains/:domainId/records` 排在 `/api/domains` 之后仍能命中，因为 `/api/domains` 的 `/:id` 不匹配多段路径，会 pass-through。但这也意味着**子路由的鉴权完全依赖自己**，父模块的 `middlewares` 不会继承。
3. **前缀唯一性按归一化比较**：`/api/Logs` 与 `/api/logs`、`/api/domains/:id/records` 与 `/api/domains/:domainId/records` 都算重复，第二个直接启动失败。
