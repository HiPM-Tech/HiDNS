# 02 · 后端响应端点统一性审计

> 审计对象：`server/src/routes/*.ts`（29 个文件，13 982 行，不含 `*.test.ts`）与响应相关的 middleware / utils。
> 权威依据：`root.ai.md:797-810`（外部应用集成 API · 通用响应格式）与 `docs/api.md:17-28`。
> 方法：静态扫描 `res.json / res.send / res.status / res.redirect / res.setHeader / sendError`；对每个 `res.json(` 取花括号平衡后的对象字面量，提取字段名做形态归类。所有数字可用同一脚本复现，未运行服务器、未抓包。
> 结论先行，每条结论后附 `文件:行号`。

---

## 一、结论摘要

1. **规范要求的「单一信封」并不存在，实际有 3 套封装 + 4 套 `code` 口径。** `utils/http.ts:69,77`（sendSuccess/sendError，`{code,data,msg}`）、`utils/response.ts:23,35`（ResponseHelper，`{code,msg,data,timestamp}`）、`middleware/errorHandler.ts:51-52`（`{code,message,details,timestamp}`，字段名是 **message 不是 msg**）。挂载到 app 的是第三个（`app.ts:212,668`），第二个只被 `routes/emailTemplates.ts` 使用，而 `utils/response.ts:154` 的 `globalErrorHandler` **从未注册**（死代码）。
2. **18 个路由文件绕过封装直接写响应，共 340 处 JSON 响应体。** 其中 261 处是手写的 `{code,msg[,data]}`（形态对、但绕过了封装，同样的校验/时间戳/错误码逻辑被复制 261 次），79 处根本不是这套信封（`{error}` 32 处、`{success,error}` 13 处、其他 34 处）。
3. **145 / 242 处 `sendError` 没有传状态码**，落进 `utils/http.ts:77-83` 的默认分支：HTTP **200** + `code: -1`。也就是说「账号不存在」「无权限」这类失败对外是 200。
4. **同一语义存在 2–4 种状态码**：资源不存在 = 404（teams/records/tunnels）或 200/-1（accounts）；无权限 = 403（teams）或 200/-1（accounts）；参数校验 = 400（多数）或 422（仅 workflows）；上游失败 = 502（仅 workflows）或 200/-1（accounts provider error）。
5. **分页有 4 种返回结构、3 套默认 pageSize（20 / 50 / 100）、2 处完全没有上限**，且 `docs/api.md` 的默认值与代码不一致。
6. **99 处响应把 `error.message` / `getError()` 原样回显**，其中包含数据库与上游厂商报文；`NODE_ENV` 判定只在 `middleware/errorHandler.ts:93` 生效，绕过它的路由在生产环境同样回显。
7. **429 与部分 401 根本不是 JSON**：限流器只配了字符串 `message`（`middleware/rateLimit.ts:12,30,46,58,91`），express-rate-limit 7.5.1 用 `response.send(message)` 直发（`node_modules/.pnpm/express-rate-limit@7.5.1_express@4.22.1/.../dist/index.cjs:668`），返回 text/html，前端 `res.data.code` 解析必失败。

---

## 二、不合规端点清单

### 2.1 封装层自身：三套方言，一套是死代码

| 位置 | 形态 | 问题 |
| --- | --- | --- |
| `server/src/utils/http.ts:69-73` | `{ code: 0, data, msg }` | 与规范一致（无 timestamp）。是事实上的主封装，被 18 个路由文件引用 |
| `server/src/utils/http.ts:77-83` | `{ code, data, msg }` | `code = statusCode >= 400 ? statusCode : -1`；**默认 statusCode = 200** → 失败也是 200 |
| `server/src/utils/http.ts:85-87` | `sendServerError(res, msg='Database error')` | **0 处调用**；`routes/accounts.ts:9`、`routes/domains.ts:12` 只是 import 了它，属未使用导入 |
| `server/src/utils/response.ts:23-33` | `{ code:0, msg, data, timestamp }` | 多出 `timestamp` 字段，与主封装不一致；仅 `routes/emailTemplates.ts` 使用 |
| `server/src/utils/response.ts:35-42` | `code: statusCode`（默认 400） | 同语义下 `code` 取值口径与 `utils/http.ts` 不同 |
| `server/src/utils/response.ts:154` | `globalErrorHandler` | **从未注册**（`app.ts:668` 挂的是 `middleware/errorHandler.ts` 的 `errorHandler`）→ 死代码 |
| `server/src/middleware/errorHandler.ts:42-58` | `{ code, message, details, timestamp }` | **字段名 `message`**，与规范 `msg` 冲突；这是全局兜底，绝大多数 500 走这里 |
| `server/src/middleware/errorHandler.ts:60-70` | `{ code:400, message:'Validation failed', details }` | 同上，字段名不合规 |

> 影响面：任何未被路由自身 catch 住的异常，返回体是 `message`；任何被路由 catch 住的异常，返回体是 `msg`。前端/第三方适配器无法用一套字段名解析。

### 2.2 未走 sendSuccess/sendError 的路由（按文件，含实际形态）

下表「行数」是与 `res.json/send/status/redirect/setHeader` 直接相关的代码行数（同一行可能是链式调用）。

| 文件 | 直接响应行 | 主要形态 | 代表位置与示例 |
| --- | --- | --- | --- |
| `auth.ts` | 64 | `{code,msg[,data]}` 手写（含 `json()` 37 + `status().json()` 27） | `auth.ts:464-468` `res.json({code:0,data:{publicKey},msg:'success'})`；`auth.ts:1453` `{code:0,data:{pinnedDomains}}` **缺 msg** |
| `mcp-oauth.ts` | 55 | OAuth2 标准体 | `mcp-oauth.ts:328` `{error:'unsupported_response_type',error_description:…}`；`:540` `{client_id,client_secret,…}`；`:676` `{access_token,refresh_token,token_type,expires_in,scope}`；`:939` `{active:false}`；`:401,408,414,438` `{redirect_url}` |
| `settings.ts` | 44 | `{code,msg}` 手写 | `settings.ts:205` `res.status(400).json({code:400,msg:'Password is required'})` |
| `security.ts` | 42 | `{code,msg[,data]}` 手写，错误用 `code:1` | `security.ts:60` 成功、`:63` `res.status(500).json({code:1,msg:'Failed to validate password'})`、`:212,215` 同款 |
| `init.ts` | 29 | `{code,msg[,data]}` 手写 | 与 `app.ts:483-487` 的 503 同族 |
| `ns-monitor.ts` | 24 | **`{success,data,error}` 与 `{success:false,error}`** | `ns-monitor.ts:228-231` `res.json({success:true,data:{list,total,page,pageSize}})`；`:83-86`、`:92-95`、`:124`、`:301`、`:336`、`:346`、`:429`、`:481`、`:596` 全部是 `{success:false,error:'…'}` |
| `tokens.ts` | 16 | `{code,msg[,data]}` 手写 + 回显异常 | `tokens.ts:68` 成功；`:70` `res.status(500).json({code:500,msg: error.message})` |
| `mcp-config.ts` | 15 | 协议体 | `mcp-config.ts:67` `res.status(200).json({keys:[jwk]})`（JWKS）；`:269,374,493` 元数据直发；`:70,272,377,496` `{error:'server_error',error_description}` |
| `tunnels.ts` | 13 | `{code,msg[,data]}`，错误恒 200 | `tunnels.ts:80` 成功；`:82` `res.json({code:-1,msg:e.message})`（HTTP 200） |
| `mcp-apikeys.ts` | 11 | `{code,msg[,data]}` 手写 | 与主封装同形但未复用 |
| `mcp-protocol.ts` | 10 | 同文件两种方言 | `:114-119` `{code:400,msg,data:null}` 是应用信封；`:133-140` `{error:'unauthorized',error_description,oauth_metadata_uri}` 是 OAuth 体；`:250-256` 同 |
| `webauthn.ts` | 9 | `{code,msg}` 手写 | `webauthn.ts:45` `{code:-1,msg:'Failed to generate challenge'}`（500）；`:49` 成功 |
| `rdap.ts` | 7 | RFC 9083 体 | `rdap.ts:222,244,282` `{errorCode,title,description}`；`:299` `{objectClassName,rdapConformance,notices}` |
| `audit.ts` | 6 | CSV/JSON 附件 | `audit.ts:139-141` `setHeader(Content-Type:text/csv)` + `res.send(csv)`；`:186-188` JSON 附件同样绕过信封 |
| `system.ts` | 4 | `{code,msg}` 手写 + 回显异常 | `system.ts:37-40` `res.status(500).json({code:500,msg:error.message})`；`:71` 成功 |
| `network.ts` | 3 | `{code,msg,data}` 手写 | `network.ts:66-70` |
| `providers.ts` | 3 | **`{error:'…'}`** | `providers.ts:69` `res.status(404).json({error:'Icon not found'})`；`:91` `{error:'Failed to load icon'}`；`:86` `res.send(iconData)` 二进制（合理） |
| `mcp-audit.ts` | 2 | `{code,msg}` 手写 | 与主封装同形 |

**只用封装、未直接写响应的 11 个文件**：`accounts.ts`、`domains.ts`、`records.ts`、`teams.ts`、`users.ts`、`servicemonitor.ts`、`resource-monitor.ts`、`workflows.ts`、`audience.ts`、`emailTemplates.ts`、`securityPolicy.ts`（最后两者走 ResponseHelper/仅 sendSuccess）。

### 2.3 真正跑偏的三个模块（非协议要求）

| 模块 | 位置 | 实际形态 | 与规范的冲突 |
| --- | --- | --- | --- |
| NS 监控 | `ns-monitor.ts:83,92,124,171,301,326,336,346,429,438,481,587,596` | `{ success:false, error:'…' }` | 无 `code`、无 `msg`；成功体是 `{success:true,data}`（`:228,280,406,607`） |
| 提供商图标 | `providers.ts:69,91` | `{ error:'Icon not found' }` | 无 `code`、无 `msg` |
| MCP 401 | `mcp-protocol.ts:133-140,250-256` | `{ error, error_description, oauth_metadata_uri }` | 与同文件 `:114` 的应用信封并存（OAuth 发现语义有据，但应登记为例外） |

### 2.4 协议类端点（差异有据，建议登记为白名单而非「修掉」）

- `mcp-oauth.ts`（RFC 6749 / 7662 / 7591）、`mcp-config.ts`（RFC 8414 / JWKS）、`rdap.ts`（RFC 9083）、`mcp-protocol.ts` 的 401：这些端点的响应体由协议规定，**不应**改成 `{code,msg,data}`。当前问题不是「存在例外」，而是**例外没有清单**——评审时无法区分「协议要求」与「随手写的」。

### 2.5 非 JSON 端点（形态合规，错误体不合规）

- `audit.ts:139-141`（CSV）、`audit.ts:186-188`（JSON 附件）、`providers.ts:86`（图标二进制）：成功响应不必是信封（建议明确豁免），但**失败时**仍返回 JSON——需要统一到信封。
- `mcp-oauth.ts:401,408,414,438`：`{redirect_url}` 是前端跳转用的业务体，属应用信封应覆盖的范围。

---

## 三、状态码矩阵

### 3.1 实测分布（`res.status(N)` + `sendError(res,msg,N)` 合计）

| 状态码 | 次数 | 集中文件 | 实际场景 |
| --- | --- | --- | --- |
| 200（显式） | 13 | mcp-oauth(8)、mcp-config(4)、records(1) | OAuth token/元数据成功；`records.ts:663` **批量加记录部分失败也用 200** |
| 200（默认，隐性） | ≈145 | accounts、domains、tunnels、security… | `sendError` 未传码 → `code:-1` |
| 201 | 1 | mcp-oauth.ts | 注册客户端 |
| 400 | 95 | auth(21)、mcp-oauth(20)、init(11)、security(10)、settings(7)、ns-monitor(6) | 参数缺失/格式错误 |
| 401 | 14 | auth(6)、mcp-oauth(4)、mcp-protocol(2) | 未认证、令牌失效、登录失败（`auth.ts:565`） |
| 403 | 31 | teams(16)、servicemonitor(5)、auth(3)、init(2)、workflows(2) | 无权限、管理员限定、初始化已关闭 |
| 404 | 49 | teams(17)、workflows(8)、ns-monitor(5)、servicemonitor(4)、records(3)、tunnels(3) | 资源不存在 |
| 409 | 2 | auth(1)、workflows(1) | 冲突（重名/重复启用） |
| 422 | 9 | **仅 workflows** | 校验失败、数据损坏 |
| 429 | 3 | auth(3) | 登录限流；另有中间件层 429（非 JSON） |
| 500 | 94 | auth(16)、security(15)、mcp-oauth(13)、settings(12) | 未分类异常（大量直接回显 `error.message`） |
| 502 | 3 | **仅 workflows** | 上游/外部调用失败 |
| 503 | 3 | init(1)、mcp-protocol(1)、workflows(1) | 系统未初始化（`app.ts:483-487`）、MCP 关闭、工作流停用 |

### 3.2 同一语义、不同返回（可复现的两两对照）

| 语义 | 返回 A | 返回 B | 结论 |
| --- | --- | --- | --- |
| 资源不存在 | `teams.ts:213,266,322,375,435` `sendError(res,'Team not found',404)` → **404 + code 404**；`records.ts` 等同类 | `accounts.ts:290,472` `sendError(res,'Account not found')` → **HTTP 200 + code -1** | 同一语义，状态码 200 与 404 并存 |
| 无权限 | `teams.ts:220,273,328,382,442,528` → **403 + code 403** | `accounts.ts:188` `sendError(res,'Permission denied')` → **HTTP 200 + code -1** | 越权失败被报成成功状态码 |
| 参数校验失败 | `middleware/validate.ts:10,14` → **400 + code -1**；`settings.ts:205` → **400 + code 400** | `workflows.ts:89,191,234,262,407,484,488` → **422 + code 422** | 三种组合 |
| 上游/厂商失败 | `workflows.ts:215,255,296` → **502** | `accounts.ts:222,226,380,384` → **200 + code -1**，且 msg 带回显报文 | 网关语义缺失 |
| 认证失败 | `middleware/auth.ts:24,54` → **401 + code -1** | `auth.ts:565` → **401 + code 401**（`sendError(...,401)`） | `code` 口径不同 |
| 部分失败 | `records.ts:663` `sendError(res, errors.join('; '), 200, {addedIds})` → **200 + code -1 + data** | 无其他端点这么表达 | 建议改为 207/422 或统一 `code` |

### 3.3 `code` 字段的四种口径（规范只说 `code !== 0`，因此四种都"合法"，但无法互操作）

1. `code = HTTP 状态码`：`utils/http.ts:77-83`（显式传码时）、`utils/response.ts:35`、`security.ts:63`（`code:1`除外）。
2. `code = -1`：`utils/http.ts:79` 默认分支、`middleware/auth.ts:24,54,69,90,100`、`middleware/validate.ts:10,14`、`tunnels.ts:82`、`webauthn.ts:45`。
3. `code = 1`：`security.ts:63,126,215` 等一批手写体。
4. `code = 503` 等业务码：`app.ts:483-487`。

---

## 四、分页现状

### 4.1 参数：同名不同默认、不同上限

| 位置 | 参数名 | 默认 page | 默认 pageSize | 上限 |
| --- | --- | --- | --- | --- |
| `utils/http.ts:52-66` `parsePagination` | page/pageSize | 1 | 50 | 200 |
| `app.ts:582` `/api/logs` | page/pageSize | 1 | 50 | 200 |
| `audit.ts:91` | page/pageSize | 1 | 50 | 200 |
| `accounts.ts:143-144` | page/pageSize | **0** | 20 | 100 |
| `domains.ts:186-187` | page/pageSize | 1 | 20 | 100 |
| `domains.ts:509-510`（续期域名） | page/pageSize | 1 | 20 | 100 |
| `records.ts:191` | page/pageSize | 1 | **100** | **无上限** |
| `ns-monitor.ts:222-223` | page/pageSize | 1 | 20 | 100 |
| `servicemonitor.ts:142-143` | page/pageSize | 1 | 20 | 100 |
| `resource-monitor.ts:19-20` | page/pageSize | 1 | **60** | **1440** |
| `workflows.ts:308,445` | **limit** | — | 200 / 50 | 500 / 200 |

- `accounts.ts:143` 用 `|| 0` 作默认，`page=0` 时走 **返回裸数组** 的分支（`:151-152` `sendSuccess(res, safe)`），`page>0` 才返回分页对象（`:150`）→ **同一端点两种响应形状**。
- `records.ts:191` 与 `domains.ts:398` 没有 `Math.min` 上限：`pageSize=100000` 会原样传给适配器（`records.ts:196-199` 的 `parseInt(pageSize)`）。
- `workflows.ts` 用 `limit` 而不是 `pageSize`，且没有 `page`。

### 4.2 返回结构：4 种信封 + 1 种裸数组

| 结构 | 代表位置 |
| --- | --- |
| `data:{ list, total, page, pageSize, totalPages }` | `domains.ts:424,447,564`；`accounts.ts:150`（仅 page>0） |
| `data:{ list, total, page, pageSize }`（**无 totalPages**） | `servicemonitor.ts:147`；`ns-monitor.ts:228-231`（且外层是 `{success,data}`） |
| `data:{ total, list }`（**无分页回显**） | `records.ts:202`；`app.ts:594-600`（`/api/logs`） |
| `data:{ total, items }` | `workflows.ts:323`（候选源） |
| `data: T[]`（裸数组） | `accounts.ts:152`（page=0）；`servicemonitor.ts:174`；`domains.ts:968` |
| `data:{ items, pagination:{ total,page,pageSize,totalPages } }` | `utils/response.ts:47-66` `ResponseHelper.paginated` —— **定义了但无人使用** |

### 4.3 文档与代码不一致

| 文档 | 声称 | 代码实际 |
| --- | --- | --- |
| `docs/api.md:287` `GET /api/domains` | pageSize 默认 **50**，最大 100 | `domains.ts:187` 默认 **20**，最大 100 |
| `docs/api.md:401` 记录列表 | pageSize 默认 **20**，最大 100 | `records.ts:191` 默认 **100**，**无上限** |
| `docs/api.md:296` | 「Token 认证时，直接返回数组而非 `{list,total}` 对象」 | 属实（`domains.ts` token 分支），但这是**被文档承认的形态分叉**，与「统一响应」目标相悖 |

---

## 五、错误信息泄露（内部细节外泄）

**规模：99 处响应把异常文本拼进 `msg`。** 按风险分三档：

1. **把数据库/驱动异常直接回显**（可能含 SQL 片段、表名、连接信息）
   - `domains.ts:878` `sendError(res, e instanceof Error ? e.message : String(e))`（`sync_domains` 内 `DomainOperations.*` 抛错时）
   - `domains.ts:968` 同款（拉取 provider 域名）
   - `domains.ts:1278`、`domains.ts:620` 同款
   - `records.ts:204` `sendError(res, e instanceof Error ? e.message : String(e))`（`getDomainRecords` 上游调用异常）
   - `accounts.ts:226,384` `Provider error: ${e.message}`
   - `tunnels.ts:82` `res.json({code:-1, msg:e.message})`
2. **把上游厂商报文回显**
   - `accounts.ts:222,380` `Credential check failed: ${dnsAdapter.getError()}` —— `getError()` 存的是厂商 API 原文（如腾讯云 `AuthFailure.SignatureFailure`）
   - `workflows.ts:215,255,296` `sendError(res, error.message, 502)`
3. **把内部校验/状态文案回显**
   - `auth.ts:540,563,565` 拼 `failedResult.message`（`auth.ts:565` 还会在密码错误时附上锁定提示，等于把「用户名存在与否 + 尝试次数」一并暴露）
   - `auth.ts:1179` `sendError(res, passwordCheck.message!, 400)`

**对照：全局兜底是安全的**——`middleware/errorHandler.ts:93` 在非 development 下不回显 `err.message`；`utils/response.ts:174-176` 也有同样保护。问题在于 **routes 自己 catch 的那 99 处完全绕过了这层保护**，生产环境照样回显。

**同类错误文案不一致**（同一件事，三种说法）：资源不存在在 `accounts.ts` 是 `'Account not found'`、在 `domains.ts:187` 是 `'Domain not found'`、在 `teams.ts` 是 `'Access denied'/'Permission denied'` 混用（`teams.ts:220` vs `:273`）；无权限在 `accounts.ts:188` 是 `'Permission denied'`、`teams.ts:220` 是 `'Access denied'`。

---

## 六、建议（接口方向）

### 6.1 统一封装（先做，成本最低）

1. **只保留一个信封工厂**：以 `utils/http.ts` 的 `{ code, data, msg }` 为唯一真源（它已经符合 `root.ai.md:797-810`），删除 `utils/response.ts` 的 `ResponseHelper` 与 `globalErrorHandler`（死代码），把 `routes/emailTemplates.ts` 迁过去。
2. **把 `middleware/errorHandler.ts` 的字段名从 `message` 改为 `msg`**（`errorHandler.ts:52,63,74,82,88`），`details` 保留在 `data` 里。这是当前**最伤一致性的一处**：全局兜底与路由返回的字段名不同。
3. **`sendError` 取消默认 200**：把 `utils/http.ts:77` 的默认值改为必填（或默认 500），并对 145 处未传码的调用做一次批量补齐。若担心一次性改动过大，至少加一条 lint/测试：命中 `sendError(res, msg)` 的单参数形式即失败。
4. **中间件层响应接入同一信封**：`middleware/auth.ts:24,54,69,90,100,123,182,191`、`middleware/validate.ts:10,14`、`app.ts:483-487` 统一改为调用 `sendError`，消除 `code: -1` 口径。
5. **限流器改为自定义 handler**：`middleware/rateLimit.ts` 的 5 个 `message: '…'` 换成 `handler: (req,res)=>sendError(res,'…',429)`，否则 429 永远是 text/html。

### 6.2 错误码规范（需要一次拍板）

1. **明确 `code` 的语义**，二选一并写进 `root.ai.md`：① `code` 恒等于 HTTP 状态码（0 表示成功）；② `code` 为业务码，与 HTTP 解耦（那就要维护一张业务码表，见 `docs/api-error-codes.md` 是否已有）。
2. **建立「语义 → 状态码」唯一映射**：不存在=404、无权限=403、未认证=401、校验失败=400（**停止在 workflows 用 422 表达普通校验失败**，422 只留给「结构合法但语义不可处理」）、上游失败=502、未初始化=503、限流=429、部分失败=207 或 200+明确的 `data.failed[]`。
3. **把 `ns-monitor.ts` 与 `providers.ts` 的 `{success,error}` / `{error}` 迁到信封**——这两处没有任何协议理由。
4. **登记协议例外白名单**：`mcp-oauth.ts`、`mcp-config.ts`、`rdap.ts`、`mcp-protocol.ts` 的 OAuth 体、`audit.ts` 的下载、`providers.ts` 的图标二进制。白名单写进 `root.ai.md` 的「外部应用集成 API」节，评审时据此判断「是例外还是缺陷」。

### 6.3 分页契约

1. **统一参数**：`page`（默认 1，1-based）+ `pageSize`（默认 20，最大 100），`workflows` 的 `limit` 改成 `pageSize`（或明确它是「候选源截断」而非分页，并在文档里区分）。
2. **统一返回**：`data: { list, total, page, pageSize, totalPages }`。`totalPages` 一律给（`servicemonitor.ts:147` 与 `ns-monitor.ts:228` 目前不给）；`records.ts:202` 与 `app.ts:594` 补上 `page/pageSize`。
3. **禁止「同一端点两种形状」**：`accounts.ts:143-153` 的 `page=0 → 裸数组` 必须去掉；`domains` 的 token 分支（`docs/api.md:296` 记载）建议加显式 `format=array` 而不是靠身份隐式切换。
4. **强制上限**：`records.ts:191`、`domains.ts:398` 补 `Math.min(…,100)`；把 `parsePagination`（`utils/http.ts:52`）变成所有分页端点的唯一入口——现在只有 2 处在用。

---

## 附：本次审计未覆盖的部分

- 未运行服务、未发真实请求，所有形态结论来自源码静态读取；`express-rate-limit` 的 429 行为来自依赖源码（`dist/index.cjs:668`），未实际触发。
- 未审计 `/api/docs`（Swagger UI 静态资源）与 `app.ts` 中的静态文件/SPA 回退分支（非 API 响应）。
- `docs/api-error-codes.md` 存在但本次未逐条比对（若它是业务码表的既成事实，6.2-1 的拍板应以它为准）。

