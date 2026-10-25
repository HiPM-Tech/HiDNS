# 收尾清理台账（响应契约 / 日志卫生 / 门禁 / 腐化用例）

> 依据：两份审核报告（`ai-censorship/deepseek-v4.1-flash_review-20261023-{fe-arch,be-constraints}.md`）与执行层复核（`…-verification.md`）。
> 本文件只记录**正在做的清理**与**评估结论**，不重复评审发现。

## 1. 响应契约一致性

目标：`code === HTTP 状态`，响应体恒为 `{ code, data, msg }`（docs/api.md 第一权威）。

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| `middleware/errorHandler.ts` | `{code,message,details,timestamp}`（5 处分支） | 统一 `sendError(res, msg, status, details)` |
| `middleware/auth.ts` | 8 处 `res.status(4xx).json({code:-1,msg})` | `sendError(res, msg, 401/403)` |
| `middleware/validate.ts` | 2 处 `code:-1` | `sendError(res, msg, 400)` |
| `routes/webauthn.ts` | 2 处 `code:-1` + 500 | `sendError(res, msg, 500)` |
| `routes/security.ts` | **27 处** `res.status(4xx/5xx).json({ code: 1, msg })`（旧式 0/1 约定） | `sendError(res, msg, status)`；成功但缺 `data` 的改 `sendSuccess(res, null, msg)` |
| `routes/ns-monitor.ts` | 13 处 `{success:false, error}` | `sendError(res, msg, status)` |
| `routes/providers.ts` | 2 处 icon 端点 `{error}` | `sendError(res, msg, status)` |
| `routes/records.ts` | 批量接口无上限 | `MAX_BATCH_RECORDS = 100`，超出 **422**（docs/api.md 已同步） |
| `routes/emailTemplates.ts` | **未挂载的死路由**（真实路由在 `records.ts` 的 `emailTemplatesRouter`，且经 ResponseHelper 输出第四种形状） | 删除（252 行） |

守护：`server/src/routes/__tests__/error-contract.test.ts` 扩展为——
1. 扫描 `routes/` 与 `middleware/`，出现 `code: -1` 即失败；
2. 直接调用 `errorHandler`，断言 AppError / 未知异常 / JWT 过期都返回信封且 `code === HTTP`，且不再带 `message` 键；
3. 另加一条：**不带状态码的 `res.json({ success|error: … })` 也一律失败**（此前只扫 `res.status(N).json`，200 路径的裸形状可逃检）；
4. 解析式扫描 `res.status(N).json({...})` 块，要求块内 **必须有 `code` 且等于 N、必须有 `msg`**（缺 code 的 `{success,error}` 这类此前整类逃检）；扫描范围扩到 `routes/ + middleware/ + api/`；协议端点（`mcp-oauth`、`mcp-config`、`rdap`）走显式 allowlist。

> 说明：`lib/dns/providers/*` 里的 `code: -1` 是**适配器内部返回值**（不直接出网），不在本契约范围内。

## 2. 日志卫生

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| `routes/auth.ts:285` | `body: body.toString()`（含 `client_secret` / `code`） | `bodyKeys: [...]`（只打字段名） |
| `routes/auth.ts:294` | `payload: tokenPayload`（含 `access_token` / `id_token`） | `keys` + `hasAccessToken` / `hasIdToken` |
| `routes/auth.ts:390-391` | `header` / `payload` 全量 | `alg/kid` + `keys/iss/aud` |

## 3. 门禁命令

`root.ai.md` §客户端架构 6 已补服务端门禁：`cd server && npx tsc --noEmit && npx vitest run && npx eslint . --max-warnings=0`，并注明 `*.test.node.ts` 走 `test:node`。

## 4. 四个被排除用例：评估结论（实测）

把 4 个文件复制成 `tests/_probe-*.test.ts` 后逐条实跑（绕开 exclude），真实报错：

| 用例 | 实测报错 | 性质 |
| --- | --- | --- |
| `db-migration.test.ts`（575 行） | `Cannot find module '../src/db/init-dsm'` | 导入路径在重构中失效 |
| `proxy-config.test.ts`（403 行） | `Cannot find module '/src/db/business-adapter'`；修好导入后 → `no such table: system_settings` | 导入失效 + 依赖已建表 |
| `ns-monitor.test.ts`（355 行） | `no such table: users` / `ns_monitor_status` | 依赖已建表 |
| `domain-filter.test.ts`（427 行） | `no such table: users` / `domains` | 依赖已建表 |

尝试过的修复：把 `business-adapter` 指到 `db/bal/business-adapter`、在 `beforeAll` 里加 `initSchema()`——仍报 `no such table`，说明 `initSchema()` 并不建表（建表由 DSM reconciler 负责），**不是改几行导入就能救活**。

### 建议处置（供负责人拍板）

| 方案 | 成本 | 收益 |
| --- | --- | --- |
| A. 建 `tests/helpers/test-db.ts`（临时 sqlite + DSM 建表 + 关库清理），再修 4 条 | 中（约 0.5–1 天） | 恢复 ~1760 行集成覆盖：迁移、代理、NS 监控 CRUD、域名过滤 |
| B. 保留排除 + 在 `root.ai.md` 与本文登记「已知缺口」 | 已做 | 门禁可信，但覆盖缺口长期存在 |
| C. 删 2 修 2（删 `proxy-config`、`db-migration`；`ns-monitor`、`domain-filter` 改走 test-db 助手） | 中 | 保留最贴近业务的覆盖 |

### 最终处置（2026-10-23 执行 C 的加强版）

1. 新建 `tests/helpers/test-db.ts`：临时 sqlite + `initializeDSM()` 建表 + 结束时删库文件（实测有效，替代了旧 `initSchema()` 的误用）。
2. 用真实 schema 修补 `domain-filter` 时暴露 **schema 漂移**：`users.password` 已改名 `password_hash`、相关 fixture 全部过期——单条用例的移植成本约 200 行，且价值低于同等的纯函数覆盖。
3. 因此：**删除 4 个不可运行的历史用例**，用两条针对性用例补回其「意图」：
   - `tests/db-bootstrap.test.ts`：新库能被 DSM 建起来、关键表存在、`users` 用 `password_hash`（覆盖原 db-migration 的意图）；
   - `src/utils/domain-classify.test.ts`：顶域/子域分类（覆盖原 domain-filter 的意图）。
4. 顺带修掉一个真实缺陷：`normalizeDomain()` 未去掉末尾点，导致 `getRootDomain('example.com.')` 返回 `com.`——现已按 FQDN 语义去掉一个末点，并有用例守住。
5. `vitest.config.ts` 的 `exclude` 清空到只剩 `node_modules` / `dist` / `*.test.node.ts`，不再有「静默排除」。

### 审核团确认（第三轮）

复核结论：R1 口子已堵（注入坏响应能被判出）、非信封端点清零（仅剩协议豁免 mcp-oauth 34 / mcp-config 5 / rdap 3）、P1-4 可闭合。余 3 条 P3 的处置：

| P3 | 处置 |
| --- | --- |
| allowlist 按 basename 整文件豁免 `mcp-config.ts` | **接受**：MCP 发现文档是外部标准规定的形状，改为按端点（逐条）豁免成本高于收益；已在 allowlist 注释写明原因 |
| 守护只覆盖 `res.status(N).json` | **已修**：新增「裸 `res.json({success|error})` 即失败」扫描 |
| 批量 422 只有常量用例 | **接受为已知限制**：路由级断言需要 seed 一个带权限的域名 + 假请求，收益低于成本；422 分支有 `MAX_BATCH_RECORDS` 常量守护与文档同步 |

未补回的部分（明确登记为缺口）：DB 迁移回滚、代理配置持久化、NS 监控 CRUD/告警抑制——这三块目前**只有路由与服务层的单测**，没有端到端集成用例。

## 5. P2/P3 全量闭合（第二批）

### 后端

| 编号 | 问题 | 处理 |
| --- | --- | --- |
| BE-P2-5 | 批量新增绕过 `resolveLineInput` | 批量循环内逐条走同一归一化点（`line`/`proxied` 与单条一致） |
| BE-P2-6 | 分页口径四处发散 | `grouped` 从 100000 收到 **1000**；`docs/api.md` 新增「分页口径」总表登记 50/200、60/1440 的例外理由 |
| BE-P2-7 | `allowedDomains === []` 注释与实现相反 | 注释改为「null/[] = 不限制、[ids] = 白名单」，与 `service/token.ts` 统一 |
| BE-P2-8 | provider 日志违反工厂、`log.error(msg, string)`、静默吞错 | `dnshe/auth`、`dpdns_reverse/adapter` 改用 `createProvider*Logger`；`aliyun` 的错误日志改 `{ error }` 并补 `getDomainRecords` 失败日志 |
| BE-P2-9 | 列表接口每请求多条 info | `records` 11→4、`domains` 23→14，逐请求链路全部降为 debug |
| BE-P2-10 | `serviceMonitorJob` 直连 dal；`app.ts` 残留未用导入 | 新增 `db/lifecycle.ts`（只暴露 `reconnectDatabase`，不拉业务适配器）；删除未用导入 |
| BE-P2-12 | 文档漂移 | RDAP 注册方式、`grouped` 参数、分页表、提供商清单（22→**26**，补 `hidns_v2`/`dnsneko`/`dpdns_reverse` 与 `virtual` 说明） |
| BE-P3-1/2/3 | allowlist 整文件豁免、批量 422 只有常量 | mcp-config 改为**按 `/.well-known` 端点豁免**并新增「协议形状」断言；批量上限抽成 `assertBatchSize()` 并测 0/1/100/101 边界 |

### 前端

| 编号 | 问题 | 处理 |
| --- | --- | --- |
| FE-P2-3 | 42 处告警条样板、无 `ui/alert` | 新增 `ui/alert`（`Alert` + `alertVariants`），27 个文件统一引用，重复 class 字符串清零 |
| FE-P2-7 | 文档目录结构漏 `utils/types/styles/test`、"四件套齐全"不符 | `root.ai.md` 目录树补全并标注「纯展示页可无 use-*」「用例按页面补」 |
| FE-P2-12 | 默认背景图第三方外连 | 新增 `VITE_DEFAULT_BACKGROUND=none` 构建期开关（`lib/theme.tsx` + 落地页共用），并写进 `root.ai.md` |
| FE-P1 | `rsaEncrypt` 绕过 `lib/http` | 走 `request + expectData` |
| FE-P2-2/4/5/8/9/10/11 | unwrap 重复、格式化、超时契约、死配置、未用依赖、无用广播、对比度 | 前一批已闭合（提交 `e661cab`） |

### 终局核验后的补修（第三批）

审核团终局核验指出 3 处残留，均已修：

| 残留 | 处理 |
| --- | --- |
| `records.ts:121/127/136/138` `getAdapterForDomain` 内 4 条 info（每个列表/写请求都触发） | 全部降为 debug；`records.ts` 的 `log.info` 计数 11 → **0** |
| 契约测试用「向前 2000 字符含 `.well-known`」启发式豁免 | 改为**端点级**：取块前最近一次 `router.<method>('path'` 声明判断，同文件后续普通端点不再被连带豁免 |
| 裸 `res.json({success|error})` 扫描只匹配单行 | 改为多行解析；并**注入验证**：往 `records.ts` 注入 `res.json({\n success: false,\n})` 后测试 1 failed、移除后 9 passed |
| `domains.ts:817/929` 的 100000 易被误判为分页口径 | 加注释说明是「提供商全量同步」的内部阈值 |
| `allowed_domains: []` 的放开语义缺少对外说明 | `docs/api.md` 新增「API 令牌的 allowed_domains 语义（安全边界）」表，并提醒收紧时同步 `routes/tokens.ts` |

## 6. 本轮验证

```
server: npx tsc --noEmit → 0 错；npx vitest run → 61 文件 / 544 条全绿（新增 3 条契约用例）
```
