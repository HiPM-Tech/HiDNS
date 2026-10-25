# HiDNS 后端约束审核报告（deepseek-v4.1-flash · 2026-10-23 · be-constraints）

- 审核员：be-constraint-review（代码审核团 · 后端约束审核）
- 工作区：`/workspace/HiDNS`，范围：`server/`
- 全程只读：未修改任何源码，未执行 `git commit` / `git push`
- 触发依据：`root.ai.md` 第 5 条（读到本文件必须做全面代码审查）

## 范围与方法

1. 精读 `root.ai.md` 全文（711 行）与 `docs/api.md` 全文（1046 行），以 `docs/api.md` 为 API 语义第一权威。
2. 分层约束：全量比对 `server/src/api/`、`routes/`、`service/`、`db/bal` 的导入关系（grep 全量，非抽样）。
3. API 语义：统一信封、`code === HTTP status`、分页默认/上限、掩码往返、`line` 语义、初始化门禁三态与大小写比较。
4. 数据库：SQL 参数化与动态 SET/WHERE 取值来源、外键级联与 SQLite 外键开关、事务使用点。
5. 安全与日志：逐路由统计鉴权中间件覆盖、凭据与令牌是否进日志、高频日志刷屏风险。
6. 适配器：统一接口、日志工厂、错误吞噬。
7. 门禁实跑（真实输出与退出码见「门禁实跑结果」）：tsc / vitest / eslint / tsx --test。
8. 文档漂移：逐项比对 root.ai.md、docs/api.md 与代码及挂载方式。

说明：本次审核**未发现 P0**，故未触发 root.ai.md §代码审核团 2 的「多次 P0 立即上报」条款。

## 结论

后端分层与初始化门禁的核心约束（三态门禁、大小写归一、探测抛错、BAL 唯一出口、掩码往返、外键级联）**执行到位**；缺陷集中在**响应契约一致性**与**日志卫生**：鉴权中间件与全局错误处理仍是 `code:-1` / `message` 两套语义，与 docs/api.md 的 `{code,data,msg}`、`code === status` 契约冲突；OAuth 凭据与令牌在 debug 级日志中明文落盘。
四道门禁真实全通（tsc 0 / vitest 541 通过 / eslint 0 / node:test 149 通过），但 `vitest.config.ts` 静态排除 4 个已腐化用例，门禁「全绿」需附限定条件解读。

发现计数：**P0 = 0，P1 = 4，P2 = 8**（发现表上限 12 条，已用满）。

## 发现表

| # | 级别 | 置信度 | 位置 | 一句话结论 |
|---|------|--------|------|-----------|
| 1 | P1 | HIGH | `middleware/auth.ts`:24,54,69,90,100,123,182,191；`middleware/validate.ts`:10,14；`routes/webauthn.ts`:45,125 | 12 处错误响应返回 `code:-1`，违反 docs/api.md「code 与 HTTP 状态码一致」 |
| 2 | P1 | HIGH | `middleware/errorHandler.ts`:49-96 | 全局错误信封是 `{code,message,details,timestamp}`，缺 msg/data，前端只能显示 HTTP 500 |
| 3 | P1 | HIGH | `routes/auth.ts`:285,292-294,390-391 | OAuth 请求体（含 client_secret/code）与令牌响应（access_token/id_token）被 debug 日志明文记录 |
| 4 | P1 | HIGH | `routes/records.ts`:591-678 | `POST /records/batch` 无条数上限，docs/api.md:41 承诺的「批量超上限 → 422」无实现 |
| 5 | P2 | HIGH | `routes/records.ts`:648（对比 475-479） | 批量新增绕过唯一归一化点 `resolveLineInput`，line/proxied 语义与单条创建不一致 |
| 6 | P2 | HIGH | `domains.ts`:187；`audit.ts`:91；`api/modules/logs.ts`:53；`resource-monitor.ts`:20 | 分页口径四处发散（20/100、50/200、1440、grouped 时 100000），与文档默认 20/上限 100 不一致 |
| 7 | P2 | HIGH | `middleware/auth.ts`:159-175；`service/token.ts`:183-184 | `allowedDomains === []` 的语义在同一函数内注释自相矛盾，实现为「允许全部域名」 |
| 8 | P2 | HIGH | `providers/dnshe/auth.ts`:4；`providers/dpdns_reverse/adapter.ts`:11；`providers/aliyun/adapter.ts`:75,111-114 | 违反 provider 日志工厂强制项；`log.error(msg, string)` 破坏 data 结构；部分 catch 完全无日志（静默吞错） |
| 9 | P2 | HIGH | `routes/records.ts`:177,186,188,197,199,201,204；`domains.ts`（23 处 log.info） | 列表接口每请求固定多条 info 日志，违反 §日志 9「同调用点必须限流」 |
| 10 | P2 | HIGH | `service/serviceMonitorJob.ts`:4；`app.ts`:223 | 服务层直连 db/dal/connection；app.ts 残留未使用的 workflowsRouter 导入 |
| 11 | P2 | HIGH | `vitest.config.ts`:28-36；`root.ai.md`:559-563 | 门禁静态排除 4 个腐化用例与全部 *.test.node.ts；root.ai.md 未记录服务端门禁命令 |
| 12 | P2 | HIGH | `docs/api.md`:15 vs 637-641；523；723-730；302-312；`root.ai.md`:296-301 | 文档漂移合集：system 鉴权、RDAP 挂载方式、Cloudflare Tunnel 空表、grouped 参数、提供商数量 |

## 逐条详情

### 1. P1 · 错误响应 `code:-1` 违反 `code === HTTP status` 契约

- **证据**：`middleware/auth.ts` 的 8 处响应（401/403）与 `middleware/validate.ts`:10,14（400）、`routes/webauthn.ts`:45,125（500）统一写 `{ code: -1, msg }`。
- **冲突权威**：`docs/api.md`:32-43「code **与 HTTP 状态码一致**（不再出现「HTTP 200 + code:-1」）」；root.ai.md:585-598；`client/src/lib/http.ts`:99,118 以 `envelope.msg` 取错误文案、ensureOk 判 `code !== 0`。
- **影响**：按文档实现 `code === status` 的第三方适配器（root.ai.md §外部应用集成 的 DDNS-Go / acme.sh 场景）在 401/403 分支无法区分「未认证」与「无权限」；与 `utils/http.ts`:84-91 的 sendError（code = status）并存两套语义，任一处改动都会静默改变契约。
- **建议**：改为已存在的统一出口——`middleware/auth.ts` 顶部 `import { sendError } from '../utils/http'`，把 `res.status(401).json({ code: -1, msg: 'Unauthorized' })` 换成 `sendError(res, 'Unauthorized', 401)`，403/400/500 同理；validate.ts、webauthn.ts 同法。改完在 `routes/__tests__/error-contract.test.ts` 增加断言：无 token 请求 /api/users 时 `code === 401`。

### 2. P1 · 全局错误信封缺 msg/data

- **证据**：`middleware/errorHandler.ts`:50-56、60-67、71-78、80-87、90-96 全部返回 `{ code, message, details?, timestamp }`，无 msg、无 data。
- **冲突权威**：root.ai.md:585-598、docs/api.md:17-28 规定 `{ code, data, msg }`；`client/src/lib/http.ts`:99 读的是 envelope.msg。
- **影响**：任何经 `asyncHandler` 转交 `next(err)` 的异常到达此中间件后，前端 msg 为 undefined，UI 退化展示 HTTP 500；前端无法用统一字段做错误分类，排障时表现为「前端说 500、日志说别的」。
- **建议**：5 个分支改为 `{ code: <status>, data: { details }, msg: <message> }`（保留 message/timestamp 作为可选附加字段，不破坏既有调用方），或直接调 `sendError(res, message, status, details)`；在 `routes/__tests__/error-contract.test.ts` 增加「抛错后 msg 非空」断言。

### 3. P1 · OAuth 凭据与令牌进日志

- **证据**：`routes/auth.ts`:278-285 用 URLSearchParams 拼出含 code 与 client_secret 的表单体后立即 `log.debug('Token request', { body: body.toString() })`；:293-294 输出 `access_token`/`id_token` 整包；:390-391 输出 id_token 的 header 与 payload。
- **冲突权威**：root.ai.md:171-174（日志字段规范）、§安全规范 1（JWT/API Token/OAuth 为认证要素）；全文未授权任何凭据明文日志。
- **影响**：默认 `HIDNS_LOG_LEVEL=info` 时不输出（缓解项），但排障开 debug 后 client_secret 与短期令牌落入 stdout/日志文件（SEA 场景还有 /tmp/hidns.log），可被采集链路外带。
- **建议**：:285 改为 `log.debug('Token request', { endpoint: config.tokenEndpoint, grantType: 'authorization_code', hasCode: !!code, hasSecret: !!config.clientSecret })`；:294 改为只输出 `{ status, keys: Object.keys(tokenPayload), hasAccessToken, hasIdToken }`；:390-391 删除或仅保留 `{ alg, kid, typ }`。

### 4. P1 · 批量新增无上限，与文档承诺的 422 不符

- **证据**：`routes/records.ts`:603-677 只做逐条字段与权限校验，`for (const [index, r] of records.entries())` 对长度无上限（全局 grep「records.length >」无命中）。
- **冲突权威**：docs/api.md:41 错误码契约「422 · 语义合法但不可处理（**如批量超出上限**）」。
- **影响**：已认证且有域名写权限的调用方一次请求即可驱动 N 次串行上游 API 调用；无上限时表现为请求长挂（网关超时后客户端重试 → 重复写入）、上游限流封禁、事件循环被长串 await 拖慢。
- **建议**：:608 附近加 `const MAX_BATCH_RECORDS = 100;` 与 `if (records.length > MAX_BATCH_RECORDS) { sendError(res, 'records exceeds the limit of 100', 422); return; }`；docs/api.md §8 batch 段补「上限 100 条，超出 422」；循环内加 `await new Promise(r => setTimeout(r, 0))` 让出点。

### 5. P2 · 批量新增绕过 resolveLineInput（line 语义不一致）

- **证据**：单条创建 :474-479 明确调用 `resolveLineInput(normalizeProviderType(...), { line, proxied, legacyProxied })`，注释称「line 语义收敛…唯一归一化点」（`service/record-line.ts`:1-13）。批量 :648 直接把 `r.line` 原样传入 addDomainRecord，且批量请求体类型（:603-606）没有 proxied/cloudflare/aliyunesa 字段。
- **影响**：同一份 line 输入在两条路径结果不同——cloudflare 适配器 `toProxiedValue`（cloudflare/adapter.ts:411-413）把 `'0'` 当**显式** proxied=false，而单条路径把历史哨兵 `'0'` 归一为 undefined（交给提供商默认）；huawei 适配器（huawei/adapter.ts:292 `line || '0'`）吃裸值。批量因此无法表达新契约的代理开关，行为随提供商漂移。
- **建议**：在 :646-648 的循环体内复用同一入口（与单条创建同参顺序），并把批量行类型补上 `proxied?: boolean` 后同步 docs/api.md §8 示例。

### 6. P2 · 分页口径四处发散

- **证据**：`utils/http.ts`:52-67 parsePagination 默认 50/200；`routes/records.ts`:195 显式 20/100；`routes/domains.ts`:187 `grouped === 'true' ? 100000 : Math.min(100, Math.max(1, ... || 20))`；`routes/audit.ts`:91 与 `api/modules/logs.ts`:53 用 50/200；`routes/resource-monitor.ts`:20 上限 1440；docs/api.md:304,418 只写「默认 20，最大 100」。
- **影响**：外部适配器按文档「翻页直到不足 100 条」在审计/日志接口会多翻一倍；`grouped=true` 一次可拉全量域名（10 万上限），既是内存/延迟风险，也是**未写入文档的旁路**（docs/api.md:302-312 参数表无 grouped）。
- **建议**：在 utils/http.ts 增 `DEFAULT_PAGE_SIZE = 20` / `MAX_PAGE_SIZE = 100` 常量并让 parsePagination 采用；domains.ts:187 的 100000 改为 MAX_PAGE_SIZE 或分组后分页；audit/logs 与 resource-monitor 的例外值逐条写入 docs/api.md 对应端点。

### 7. P2 · allowedDomains === [] 语义自相矛盾

- **证据**：`middleware/auth.ts`:159-160 注释「空数组 [] 表示**不允许任何域名**（白名单机制）」，紧接 :166-175 注释「空数组表示**允许所有域名**（向后兼容 ddns-go）」并 next() 放行；`service/token.ts`:183-184 同样把 length === 0 视为全放行。
- **缓解**：`routes/tokens.ts`:142-152 强制 allowed_domains 至少一个合法 ID，当前 API 造不出空数组。
- **影响**：安全判定函数上的矛盾注释——后续任一处放宽创建校验（或历史/导入数据带空数组）立即变成「全域名通配令牌」，读代码的人无法从注释判断意图。
- **建议**：统一 fail-closed：删除 :166-175 的放行分支，改为 `if (!tokenPayload.allowedDomains?.length) { sendError(res, 'Token has no domain whitelist', 403); return; }`；同步删掉 service/token.ts:184 的 `|| length === 0`；docs/api.md §18 注明「allowed_domains 至少一个」。

### 8. P2 · 适配器日志工厂与错误吞噬

- **证据**：
  - `lib/dns/providers/dnshe/auth.ts`:4 `const log = createLogger('DNS').sub('DNSHE')`；`dpdns_reverse/adapter.ts`:11 `createLogger('DNS').sub('Provider').sub('DPDNS')` —— 违反 root.ai.md:125「DNS Provider 必须使用 internal.ts 二次定义的日志工厂，不允许具体 DNS 提供商文件再次定义 createLogger('DNS') 主模块」。
  - `aliyun/adapter.ts`:75 `log.error('getDomainList failed', this.error)` —— 第二参是字符串，违反 root.ai.md §日志 5「通过第二个参数 data 传入」的结构化要求。
  - `aliyun/adapter.ts`:111-114 getDomainRecords 的 catch 只赋值 this.error 后 `return { total: 0, list: [] }`，**不记日志、不抛错**；`DnsHelper.ts`:55-78 的 createLoggingAdapter 只在 adapter **抛出**时记 error 级日志，此路径在任何级别都无日志。
- **影响**：上游读失败与「该域名确实 0 条」在 API 上完全同形（routes/records.ts:205-209 注释已承认），运维只能靠「记录数看起来不对」发现故障，与 §日志 6 的可观测性目标相反。
- **建议**：dnshe/auth.ts 与 dpdns_reverse/adapter.ts 改用 `createProviderAdapterLogger('DNSHE')` / `createProviderAdapterLogger('DPDNSReverse')`；错误日志改 `log.error(msg, { error: { name, message, stack } })`；静默 catch 至少在 return 前补 `log.sub('Adapter').tag('FAILED').warn(...)`，并在 PageResult 增可选 `error?: string` 供路由判定（records.ts:207 可据此不回写计数并提示）。

### 9. P2 · 列表接口高频 info 日志

- **证据**：单次 `GET /:domainId/records` 固定输出 6 条 info（records.ts:177 ENTRY、186、188、197、199、201、204）；`routes/domains.ts` 有 23 处 log.info。
- **冲突权威**：root.ai.md:270-274「同一调用点的重复日志必须限流…只有在首次与每 N 次记录一次」「日志刷屏属于必须上报的严重问题」，并在 :273 给出 3,200 行/秒的事故基线。
- **影响**：记录列表是前端记录页与仪表盘的轮询接口；按 10s 轮询、20 并发会话估算约 12 行/秒的固定噪声，故障时叠加适配器重试日志逼近历史事故量级。
- **建议**：删除 :177 的 ENTRY 日志与 :186/:188/:199 的流程日志，保留 :204 并降为 debug；必须保留的用模块级计数器 `if (recordsLogCounter++ % 100 === 0) log.info(...)`；domains.ts 的 23 处成功路径 log.info 降级为 debug，仅保留写操作与失败路径。

### 10. P2 · 分层残留

- **证据**：`service/serviceMonitorJob.ts`:4 `import { connect } from '../db/dal/connection'`；`app.ts`:223 `import workflowsRouter from './routes/workflows'` 全文再无引用（grep 仅此一行命中）。
- **冲突权威**：root.ai.md:118 要求连接重建等操作封装在服务层（如 service/systemSetup.ts）后由路由调用，此处形成第二个直连点；root.ai.md:363「禁止在 app.ts 直接 app.use 业务路由」在行为上已遵守，但残留导入会让维护者误判挂载关系。
- **建议**：删除 app.ts:223 该行（tsc --noEmit 仍为 0）；serviceMonitorJob 改为调用 service/systemSetup.ts 暴露的 `ensureDatabaseConnected()`（若无则在 systemSetup 内新增薄封装），把 DAL 导入点收敛为 1 个。

### 11. P2 · 门禁可信度的两个限定条件

- **证据**：`vitest.config.ts`:28-36 静态排除 tests/db-migration.test.ts、tests/proxy-config.test.ts、tests/ns-monitor.test.ts、tests/domain-filter.test.ts（4 个文件均实际存在于 server/tests/）与全部 `**/*.test.node.ts`，注释自述「已知腐化，待修」；root.ai.md:559-563 只记录客户端门禁，**没有**服务端门禁命令，真实服务端门禁只存在于 CI（.github/workflows/commit-checks.yml:113-120、test-suite.yml:96-135）。
- **影响**：按 root.ai.md 复现「后端是否通过」无命令可依；vitest 的 61 files / 541 passed 不覆盖那 4 个用例，也不能替代 test:node（149 条），「全绿」必须附条件说明，否则正是 §代码审核团 2 所指的「完全依赖门禁」。
- **建议**：在 root.ai.md §服务层后新增「门禁（服务端）」：`cd server && npx tsc --noEmit && npx vitest run && npx tsx --test "src/**/*.test.node.ts" && npx eslint . --max-warnings=0`；给腐化用例设清理期限，修一个从 exclude 删一行。

### 12. P2 · 文档漂移

| 文档条目 | 代码实际 | 证据 |
|---|---|---|
| docs/api.md:637-641 §12 表：`GET /api/system/info`、`/version` 鉴权「无」 | 两者均 authMiddleware | routes/system.ts:8,45（与同文 :15 的说明也自相矛盾） |
| docs/api.md:523「挂载于 app.use('/api/rdap', rdapLimiter, rdapRouter)」 | 挂在 api/index.ts 的模块清单 | api/index.ts:88-95、api/mount.ts:10-13 |
| docs/api.md:723-730 §17 Cloudflare Tunnel 空表 | 无 tunnel 路由（已剔除） | server/src/routes/ 无 tunnel 文件；git log e20fa7c「剔除 Cloudflare 隧道」 |
| docs/api.md:302-312 GET /api/domains 参数表缺 grouped | 支持 `?grouped=true` 且解除分页上限 | routes/domains.ts:169,187 |
| docs/api.md:766-775 §20 network 仅标 authMiddleware | /proxy 的 GET/POST 另需 noTokenAuth + adminOnly | routes/network.ts:63,82 |
| root.ai.md:296-301「共 22 个」提供商 | 另注册 hidns_v2、dnsneko、dpdns_reverse、virtual | lib/dns/providers/index.ts:5,33,37,41 |

- **建议**：按行修正上表 6 处；docs/api.md §17 整节删除（无实现）；root.ai.md 提供商小节改为「核心 22 个 + 内部扩展：hidns_v2 / dnsneko / dpdns_reverse / virtual」并注明各自能力位。

## 门禁实跑结果

全部在 `/workspace/HiDNS/server` 实跑：

| 命令 | 退出码 | 真实结果 |
|---|---|---|
| `npx tsc --noEmit` | **0** | 无类型错误输出（仅 Node UNDICI-EHPA 实验特性告警） |
| `npx vitest run` | **0** | Test Files 61 passed (61) / Tests 541 passed (541) / Duration 46.05s |
| `npx eslint . --max-warnings=0` | **0** | 无告警输出（与 package.json 的 lint 脚本同命令） |
| `npx tsx --test "src/**/*.test.node.ts" "scripts/**/*.test.node.ts"` | **0** | # tests 149 / # pass 149 / # fail 0 / # skipped 0（8.7s） |

对 root.ai.md 所写命令的核对：

- root.ai.md:561 客户端门禁 `cd client && npx tsc -b && npx vitest run && npx vite build && npx eslint src` 与前后技术栈描述一致，属前端审核范围（本轮未执行）。
- **root.ai.md 未写服务端门禁命令**；本轮按 CI 实际步骤（commit-checks.yml:113-120）复现并全部通过（上表）。
- 门禁口径注意：`npx vitest run` 因 vitest.config.ts:28-36 的 exclude，**不含** 4 个腐化用例与所有 *.test.node.ts；上表单列 test:node 即为补齐该缺口。

## 经核实无问题

1. **初始化门禁三态与大小写**：`api/init-gate.ts`:27-74 三条路径完整（initialized 全放行 / uninitialized 只放 exemptFromInitGate / unreachable 只放 closedStateProbes 的 GET/HEAD/OPTIONS），:28-31,40 对前缀与探测路径统一 toLowerCase()，`matches` 用 `=== prefix || startsWith(prefix + '/')` 避免 /api/initx 误匹配——`GET /API/mcp/status` 绕过路径已关闭。
2. **可用性探测不吞错**：`db/connection.ts`:65-91 isDbInitialized()/hasUsers() 在连接或查询失败时抛异常（无 catch → false），:103-109 把失败显式映射为 unreachable，与 root.ai.md:116-117、484 一致。
3. **已初始化标记粘性 + 落盘**：`service/systemState.ts`:70 启动即读标记、:80-95 isInitSurfaceOpen() 仅「未初始化且探测为 uninitialized」为真、:106-127 unreachable 不回退、:133-137 落盘失败有显式告警；`app.ts`:591-597,649-652 启动期 unreachable 进入降级且不打印 initialization mode。
4. **数据库唯一出口**：全量 grep 确认 routes/*.ts 只从 db/bal/* 导入（25 个文件，含 resource-metrics-operations），无一处 import db/dal、db/dl、db/dsm、db/connection；service/ 侧仅 systemSetup.ts、systemState.ts 与第 10 条的 serviceMonitorJob.ts 触达 DAL；无 service → routes 反向依赖。
5. **SQL 参数化**：动态部分仅用于标识符/占位符/静态条件模板——`service/auditExport.ts`:47-72 的 where 由固定模板拼接、值全部走 params；`business-adapter.ts`:509 的 `SET ${setClause}` 键来自调用方构造的显式对象（如 routes/users.ts:209-231 只写 nickname/email/role_level/role/status/password_hash），无 req.body 直传键名。
6. **掩码往返**：`routes/accounts.ts`:313-320 读侧全值掩码；:369-370 写侧经 `service/account-config.ts`:33-45 mergeMaskedConfig（`***` + 原键存在 → 沿用原值；原键不存在 → 丢弃），不会把占位符写库，也不会拿 `***` 去 check()。
7. **外键级联真实生效**：`db/dsm/schemas/complete-schema.ts`:56-57,127-129 等对 team_members/domain_permissions 声明 ON DELETE CASCADE，`db/dl/sqlite.ts`:65-67 在非显式关闭时执行 `PRAGMA foreign_keys = ON`，因此 TeamOperations.delete（business-adapter.ts:1155）单行删除不会留下孤儿行。
8. **鉴权覆盖**：逐文件统计 router 动词与 authMiddleware 数量；除设计公开的 /api/auth（登录/公钥/密码重置）、/api/init、/api/rdap、/api/mcp（.well-known/*、/status、协议端点走 mcpEnabledCheck）、/api/providers/:type/icon 外，所有业务端点均有 authMiddleware；/api/users、/api/settings、/api/audit、/api/logs、/api/tokens 均带 noTokenAuth + adminOnly（与 docs/api.md:241,646,702,719,734 一致）；/api/init 四个状态变更端点全部挂 requireInitSurface（init.ts:123,184,308）并有 initLimiter（:27-35）。
9. **适配器 HTTP 出口**：lib/dns/providers/ 下无一处原生 fetch（全量 grep），全部经 requestJson/requestXml；createLoggingAdapter Proxy（DnsHelper.ts:55-78）在 createAdapter 出口统一包裹（§日志 6 的 P0 约束成立），provider 抛出路径有 error 级日志。
10. **统一信封的正向路径**：`utils/http.ts`:69-91 sendSuccess/sendError 正确实现 code:0 与 code = status，sendServerError 固定 500；routes/records.ts:674-677 的「部分成功」也是 200 信封 + 逐行结果，与文档一致。

## 需上报项目团队的事项

- **无 P0**，未触发「多次 P0 立即上报」条款，本次不上报抹杀申请。
- **P1 共 4 条**（第 1–4 条；第 5 条为 P2 但影响面与第 4 条相邻），按 §代码审核团 2「多次出现 P1 需留意并及时处理」，建议项目团队在下一迭代确认修复排期：第 1、2 条同根因（信封/状态码两套语义并存），建议合并为一次「错误响应统一化」改动；第 3 条为安全卫生项，优先级高于第 4 条。
- 门禁侧建议明确腐化用例清理期限（第 11 条），否则后续审核无法再以「vitest 全绿」作为交付证据。

## 复核（第二轮）

复核对象：提交 `522ed13`（errorHandler/auth/validate/webauthn 契约收敛 + OAuth 日志去敏 + root.ai.md 门禁）与 `43c75d7`（security.ts 27 处 + 解析式扫描）。结论：**P1-1（响应契约）已闭合，条件通过**——原 4 条 P1 中第 1、2、3 条已解决；**第 4 条（records batch 无上限）本轮未涉及，仍未闭合**。本轮新增 0 条 P1、5 条 P2、2 条 P3。

### a) 是否仍有 code !== HTTP 或非 {code,data,msg}

- 独立重扫 `routes/`、`middleware/`、`api/` 共 40 个文件、183 处手写 `res.status(N).json({...})`：**code 与 N 不一致 0 处、有 code 无 msg 0 处**（与提交自述「27 → 0」一致，且本次为独立脚本复核，非采信提交说明）。
- 例外确认（本就允许）：`api/init-gate.ts` 503 为 `{code:503,msg,data}` 合规；`routes/mcp-oauth.ts` 34 处、`routes/mcp-config.ts` 5 处 well-known、`routes/rdap.ts` 3 处为协议裸 JSON（docs/api.md:552 与 RFC 7483 要求），**不属于违规**。
- **仍未收敛的非协议端点**（guard 盲区，见下）：`routes/ns-monitor.ts` 13 处 `{ success: false, error }`（:82,91,120,166,290,312,322,332,412,421,464,570,579）与 `routes/providers.ts` 2 处 `{ error }`（:69,404；:91,500）。前端 `lib/http.ts` 只读 `msg`，这 13 处 4xx 的错误文案会在客户端退化为 "HTTP 400"。

### b) sendError 的 status 兜底是否掩盖真实状态

- **不会**：全仓 `sendError` 第三参均为 ≥400 的字面量或合法变量，无一处传 <400（grep 无命中），clamp 分支当前不可达。
- 反向问题仍在（非本次引入）：`routes/records.ts`:213,391,425,513,761,837,905 把适配器/上游失败一律 `sendError(res, e.message)` 默认 400，真实类别是上游故障（对比 `routes/workflows.ts`:215 已用 502）。建议改 502 并在 docs/api.md 错误码表补一行。
- 建议对 clamp 加开发期告警：`if (statusCode < 400) log.warn('sendError called with non-error status', { statusCode })`，否则误传 200 的 bug 会被静默改写成 400。

### c) errorHandler 是否引入行为回归

- 开发环境 500 透出：策略与旧实现等价（旧版仅 `details` 在 dev 透出，新版 `msg` 在 dev 透出），`NODE_ENV` 未设时走安全分支 `'Internal server error'`，无新增暴露面。
- ValidationError 的 details 位置由 `details` → `data.error`（`errorHandler.ts`:48）：全仓与 client 侧均无 `details` 消费方（client 仅 `features/mcp/api.ts` 的类型声明与 ErrorBoundary 的 HTML 标签），无回归。
- 被删的 `ApiError` 接口与 `errors` 工厂：零引用（grep 无命中），`tsc --noEmit` = 0 反向确认无遗漏。
- AppError 未被 clamp（实际使用 400/401/403），`data` 恒由 `details ?? null` 存在；MCP 抛出的 AppError 走 JSON-RPC 自处理，不经该中间件，形状无回归。
- 用例覆盖：新增 3 条（AppError / 未知异常 / TokenExpiredError）通过；`ValidationError` 与 `JsonWebTokenError` 两个分支仍无用例（P3）。

### d) 日志是否仍有敏感值

- OAuth 三处已去敏为键名/布尔（`routes/auth.ts`:286 bodyKeys、:295 keys+hasAccessToken/hasIdToken、:398-399 alg/kid 与 keys+iss/aud），`client_secret`/`code`/`access_token`/`id_token` 值不再落盘。
- 全仓扫描 `log.(debug|info|warn|error)` 与 password/secret/token/apikey 的组合：**仅剩消息文本与 error 对象**，无值泄漏。
- 残留 1 处结构风险（P3）：`routes/auth.ts`:839 `log.debug('>>> /oauth/start-bind ENTRY', { userId, body: req.body })`——当前 body 只含 `provider`，但整包打印意味着下一个字段就可能泄漏，建议改为 `{ provider: req.body?.provider }`。

### e) 门禁实跑（server/，真实数字）

| 命令 | 退出码 | 真实结果 |
|---|---|---|
| `npx tsc --noEmit` | **0** | 无类型错误 |
| `npx vitest run` | **0** | Test Files **63 passed (63)** / Tests **550 passed (550)** / 47.55s |
| `npx eslint . --max-warnings=0` | **0** | 无告警 |

### 本轮剩余问题（新增，均为 P2/P3）

| # | 级别 | 位置 | 结论 | 建议 |
|---|---|---|---|---|
| R1 | P2 | `routes/__tests__/error-contract.test.ts`:83 | `if (!codeMatch) continue;` 使**无 code 字段**的响应整类逃检，ns-monitor 的 `{success,error}` 与 providers 的 `{error}` 因此通过"全绿" | 改为：块内缺 `code` 或 `msg` 即失败，并维护显式 allowlist（`mcp-oauth.ts`/`rdap.ts`/`mcp-config.ts` 的 well-known/`providers.ts` icon）；同时把 `api/` 纳入 `SCAN_DIRS` |
| R2 | P2 | `routes/emailTemplates.ts`（全文 5 个端点，未挂载） | 死路由：实际挂载的是 `routes/records.ts`:30 的 emailTemplatesRouter；该文件经 `utils/response.ts` ResponseHelper 输出第四种形状 `{code,msg,data,timestamp}`，且含 2 个未文档化 POST | 删除该文件（文档 §9 只列 3 个 GET）；或在 `00-PLAN` 标注迁移中并暂存 |
| R3 | P2 | `root.ai.md`:562-564 | 门禁片段可执行性有缺陷：两行照抄到同一 shell 时，`cd client && …` 之后紧接 `cd server` 会报 `cd: server: No such file or directory`（实测 exit 1） | 两行改独立子 shell：`(cd client && …)` / `(cd server && …)`，或写成 `cd .. && cd server` |
| R4 | P3 | `middleware/errorHandler.ts`:47-60 | ValidationError / JsonWebTokenError 分支无用例 | 补 2 条与现有 3 条同构的用例 |
| R5 | P2 | `routes/records.ts` 上游失败路径 | 上游故障以 400 上报，类别失真 | 改 502 并写入 docs/api.md 错误码表 |

### 复核判定

P1-1（响应契约分裂）**已闭合**：errorHandler 与鉴权中间件均走 `sendError`，`code === HTTP`、`{code,data,msg}` 在 183 处手写信封上全部成立，OAuth 日志去敏到位，门禁三道全绿。**P1-4（records batch 无条数上限）未在本轮范围内，仍为未闭合 P1**，建议下一轮处理。剩余问题不影响 P1-1 的结论，其中 **R1 必须先补**——否则下一轮同类漂移仍会以"测试全绿"的形式通过。

## 复核（第三轮）

- R1 已堵上：注入 `res.status(400).json({ success:false, error })` 触发「缺少 code 字段」「缺少 msg 字段」两条；独立复扫 routes/+middleware/+api/ 167 处手写信封（allowlist 内 59）**违规 0**；ns-monitor 13 处与 providers 2 处均已改 sendError，邮件模板死路由已删除，auth.ts 改 bodyKeys。
- 非信封端点**已清零**（协议豁免 mcp-oauth/mcp-config/rdap 除外）；P1-4 可**标记闭合**（MAX_BATCH_RECORDS=100、422、docs/api.md 同步、@(cd client)`/@(cd server)` 子 shell 门禁可用），实跑 `npx vitest run` = **64 files / 551 tests passed**。
- 余 3 条 P3（不阻塞）：allowlist 按 basename 整体豁免 `mcp-config.ts`（未来同文件漂移不再拦）；守护只覆盖 `res.status(N).json`，纯 `res.json({error})` 的 200 仍可逃检；批量 422 分支仅有常量用例（@records-batch-limit.test.ts` 只断言 100），建议补一条路由级 422 断言。
