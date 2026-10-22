# 外部兼容性审计：域名相关 API（DDNS-Go 等第三方工具）

> 审计范围：root.ai.md §外部应用集成 API 描述的四个端点（域名查询、记录查询、记录创建、记录更新）
> 权威依据：`docs/api.md`（root.ai.md:779 指定为第一权威）
> 方法：**只读源码静态核对**，未启动服务、未跑真实 DDNS-Go 客户端。标「未验证」的条目不做结论。

---

## 一、结论摘要

**四个端点都存在、路径与方法正确、API Token 可用、IDN 有 `display_name` 支持。** 但与外部客户端的契约有三类实质问题：

1. **幂等性不可靠**（最高风险）：`subdomain` 过滤是**透传给上游提供商**的，服务端不做二次精确匹配；阿里云走的是 `RRKeyWord`（模糊包含），因此 `subdomain=www` 会同时返回 `www`、`www2`、`awww`。DDNS 客户端按「查到就更新」的语义，可能改写错记录。
2. **文档与实现有 5 处不一致**，其中 `docs/api-reference.md` 整节过期（字段名 `host`/`priority` vs 实际 `name`/`mx`，`PATCH .../status` + `{ enabled }` vs 实际 `PUT .../status` + `{ status }`）。按 root.ai.md:779 的口径，这已构成「未完成」。
3. **分页无上限钳制**：记录列表的 `pageSize` 直接 `parseInt` 后透传给上游，既不钳制上限也不处理 `NaN`；域名列表的默认值与文档不符（代码 20 / 文档 50）。

另有一处**文档存在但实际不可用**的端点：`GET /api/domains/whois` 被 `GET /:id` 路由吞掉（详见 R3）。

**近期工作流改动对这 4 个端点无影响**：已核对 records.ts / domains.ts 的近期提交，响应字段、路由顺序、中间件顺序均未变化（见第四节）。

---

## 二、端点对照表（实际实现 vs docs/api.md）

### 2.1 域名查询：`GET /api/domains`

| 项 | 实际实现 | docs/api.md | 一致 |
|---|---|---|---|
| 路径 / 方法 | router.get('/') — domains.ts:168 | GET /api/domains — api.md:280 | 是 |
| 鉴权 | authMiddleware（JWT + API Token 双支持） — domains.ts:168 | authMiddleware — api.md:281 | 是 |
| page | 默认 1 — domains.ts:186 | 默认 1 — api.md:286 | 是 |
| pageSize | **默认 20，上限 100** — domains.ts:187 | **默认 50**，上限 100 — api.md:287 | **否（默认值不一致）** |
| domain_match | 后缀精确匹配、按长度降序 — domain-query-builder.ts:188-217 | 有说明 — api.md:290 | 是 |
| account_id / keyword / domain_type / domain_status / include_disabled | 均有 — domains.ts:169-201 | 均有 — api.md:288-295 | 是 |
| format | 支持 format=array（返回裸数组） — domains.ts:434 | 仅写「返回格式」，**未列取值** — api.md:293 | 未文档化 |
| Token 返回 | **裸数组** + display_name（Unicode），name 保持 Punycode — domains.ts:434-440 | 「Token 认证时直接返回数组」 — api.md:297 | 是 |
| 响应含 total | Token 认证**不返回** total — domains.ts:440 | 未说明 | 未文档化 |

补充（未在 api.md 体现）：
- Token 且 allowedDomains 非空时走 DomainOperations.getByIds，**忽略 page/pageSize/domainStatus/domainType/pinned_domains**（domains.ts:228-234）。即分页参数对该类 Token 无效，一次返回全部授权域名。
- Token 且 allowedDomains 为空数组时，走分页查询并支持 domainStatus 等（domains.ts:235-268）。

### 2.2 记录查询：`GET /api/domains/:domainId/records`

| 项 | 实际实现 | docs/api.md | 一致 |
|---|---|---|---|
| 路径 / 方法 | 挂载于 /api/domains/:domainId/records，mergeParams: true — app.ts:505、records.ts:25 | 同 — api.md:392 | 是 |
| 鉴权 | 仅 authMiddleware，**无 requireTokenDomainPermission** — records.ts:174 | 「除 GET 列表外」均要求域名权限 — api.md:390、395 | 是（文档已声明例外） |
| pageSize | **默认 100，无上限、无 NaN 处理** — records.ts:191 | **默认 20，最大 100** — api.md:401 | **否（默认值与上限均不一致）** |
| subdomain | 透传给适配器 — records.ts:196-199 | subdomain 主机记录过滤 — api.md:403 | 名称一致（语义见 R1） |
| type / value / line / status / keyword | 均有 — records.ts:191 | 均有 — api.md:399-407 | 是 |
| 响应结构 | { total, list: [...] } — records.ts:202 | 未给出响应体 | 未文档化 |
| 记录字段 | id/name/type/value/line/ttl/mx/weight/status/proxiable/cloudflare/remark/updated_at — records.ts:35-49 | 未给出响应体 | 未文档化 |

### 2.3 记录创建：`POST /api/domains/:domainId/records`

| 项 | 实际实现 | docs/api.md | 一致 |
|---|---|---|---|
| 鉴权 | authMiddleware + requireTokenDomainPermission('domainId') — records.ts:430 | 同 — api.md:415 | 是 |
| 必填字段 | name、type、value — records.ts:441-450 | 示例含 name/type/value — api.md:421-423 | 是 |
| 可选字段 | line/ttl/mx/weight/remark/cloudflare.proxied/aliyunesa.proxied — records.ts:441-446 | 同 — api.md:424-430 | 是 |
| proxied 优先级 | cloudflare.proxied -> aliyunesa.proxied -> line，缺省 '0' — records.ts:470-474 | 未记录 | 未文档化 |
| 响应 | { code:0, data:{ id: <recordId> } } — records.ts:506 | 未给出响应体 | 未文档化 |
| 域名不可写 | sendError(res,'Permission denied') -> **HTTP 200 + code -1** — records.ts:437-440 | — | 见 R9 |

### 2.4 记录更新：`PUT /api/domains/:domainId/records/:recordId`

| 项 | 实际实现 | docs/api.md | 一致 |
|---|---|---|---|
| 鉴权 | authMiddleware + requireTokenDomainPermission('domainId') — records.ts:678 | 同 — api.md:435 | 是 |
| 必填字段 | **name、type、value 三者必填**（不支持只传 value 的局部更新） — records.ts:690-699 | 示例给了完整体 — api.md:439-453 | 是（但见 R8） |
| 可选字段 | line/ttl/mx/weight/remark/status/cloudflare/aliyunesa — records.ts:690-695 | 同 — api.md:444-452 | 是 |
| 响应 | sendSuccess(res) -> **无 data 键** — records.ts:751 | 通用格式含 data — api.md:19-25 | 轻微不一致 |

### 2.5 附：docs/api-reference.md（第二份文档，与实现严重不一致）

| 端点 | api-reference.md 写法 | 实际实现 | 一致 |
|---|---|---|---|
| 记录列表查询参数 | host — api-reference.md:201 | subdomain — records.ts:191 | 否 |
| 创建记录字段 | host、priority、顶层 proxied — api-reference.md:210-230 | name、mx、cloudflare.proxied — records.ts:441-446 | 否 |
| 更新记录字段 | 只传 value/ttl（暗示局部更新） — api-reference.md:239-242 | name/type/value 必填 — records.ts:696-699 | 否 |
| 启停记录 | PATCH .../status + { enabled } — api-reference.md:255-261 | PUT .../status + { status } — records.ts:842、854 | 否 |
| 域名对象字段 | records_count — api-reference.md:136 | record_count — src/types/index.ts:51 | 否 |

---

## 三、兼容风险清单（按严重度）

### R1 [P1] 幂等性不可靠：subdomain 是上游语义，服务端不做精确匹配
- 证据：records.ts:196-202 —— 参数直接透传、结果直接返回，**中间没有任何本地二次过滤**。
- 证据：阿里云把 subdomain 映射成**模糊关键字**（aliyun/adapter.ts:96-101：params.RRKeyWord = subdomain，并置 SearchMode='ADVANCED'）；DNSPod 走 Subdomain（dnspod/adapter.ts:140、156），且随 status/value 是否存在切换两个不同上游 API（dnspod/adapter.ts:134-147 vs 154-162）。
- 影响：DDNS 客户端按 root.ai.md:815 的「先查 subdomain+type、存在则更新」实现时，subdomain=www 在阿里云上会同时命中 www/www2/awww；客户端取首条更新，可能改写**非目标记录**（对动态域名是断服级后果）。
- 说明：客户端自行精确比对可规避，但这把正确性下推给调用方，与「幂等操作」的设计意图相反。

### R2 [P1] 记录列表 pageSize 无上限钳制、NaN 直接透传
- 证据：records.ts:191-199 —— 解构默认值只对 undefined 生效；无 Math.min/Math.max，也无 Number.isFinite 校验；空串时 parseInt('') 得到 NaN 后原样进入适配器。
- 对比：域名列表有钳制（domains.ts:187 Math.min(100, Math.max(1, ...))），记录列表没有 —— 同一产品两套口径。
- 影响：传 pageSize=100000 会直接打到上游（部分厂商 400 或截断，导致 total 与实际不符）。

### R3 [P1] GET /api/domains/whois 被 GET /:id 吞掉，端点实际不可用
- 证据：domains.ts:594 定义 router.get('/:id')，而 router.get('/whois') 在 domains.ts:1471 —— **定义在动态路由之后**。Express 按定义顺序匹配，/whois 先命中 /:id，Number('whois') 为 NaN（domains.ts:598），最终返回「Domain not found or no permission」。
- 对照：同文件 domains.ts:481-489 的注释自己写明「静态路由必须定义在 /:id 之前」，/renewable-domains（domains.ts:495）遵守了，/whois 没有。
- 影响：api.md:369 文档化的 GET /api/domains/whois 对外不可用。DDNS-Go 不走此端点，故不影响主流程，但属文档与实现不一致。

### R4 [P1] docs/api-reference.md 与实现大面积不一致，且是第二份「API 文档」
- 证据：见 2.5 表格（api-reference.md:201 / 210-230 / 239-242 / 255-261 / 136）。
- 影响：root.ai.md:779 规定 api.md 为第一权威且改动须同步，但仓库里同时存在这份**过期文档**。第三方按它实现（host/priority/PATCH+{enabled}），四个端点全部会失败。

### R5 [P1] Token 的 allowed_domains 白名单在记录列表端点不生效
- 证据：records.ts:174 只有 authMiddleware，没有 requireTokenDomainPermission；越权判定改由 getDomainAccess(domainId, req.user.userId, ...)（records.ts:185）完成，而 Token 的 req.user.userId 是**Token 所属用户**（middleware/auth.ts:43-47）。因此「Token 只授权域名 A」时，仍可列出其属主可读的域名 B 的记录。
- 文档状态：api.md:390 已明示「除 GET 列表外」，属**已披露行为**，不是隐藏缺陷。
- 影响：外部工具若把 allowed_domains 当硬隔离（常见预期）会意外。另见 R6：白名单为空数组时 requireTokenDomainPermission 直接放行（middleware/auth.ts:166-175）。

### R6 [P2] Token 的「服务权限」（services）从未被强制
- 证据：requireServicePermission 定义于 middleware/auth.ts:58-75，但全仓**无任何调用点**（命中定义与 import，无使用）。而 api.md:10 声称 Token「支持域名/服务/时间范围限制」。
- 影响：只有 domains.read 服务的 Token 仍可 POST/PUT/DELETE 记录（这些路由只挂域名权限）。服务维度限制事实上不存在。

### R7 [P2] 分页默认值与文档不符（两处）
- 证据：域名列表 domains.ts:187 默认 **20**，api.md:287 写 **50**；记录列表 records.ts:191 默认 **100**，api.md:401 写 **20**。
- 影响：客户端按文档估算「10 页 = 1000 条」（root.ai.md:814）时每页条数不同，会打乱分页循环。

### R8 [P2] 记录更新要求全量字段，文档示例未点明
- 证据：records.ts:696-699 —— if (!name || !type || !value) 直接报错。api.md:439-453 的示例给了完整体，因此**文档本身不算错**，但没说明「只传 value 会失败」。
- 影响：api-reference.md:239-242 恰好给了「只传 value/ttl」的示例，两份文档互相矛盾。

### R9 [P2] 错误体形状不统一：HTTP 200 承载失败，code 有时 -1 有时为 HTTP 码
- 证据：sendError(res, msg, statusCode = 200)（src/utils/http.ts:77-83）默认 **HTTP 200**，body code 为 statusCode >= 400 ? statusCode : -1。因此：
  - 处理器内业务失败（records.ts:438 'Permission denied'、records.ts:448 缺字段）-> **HTTP 200 + code -1**
  - 中间件拒绝（middleware/auth.ts:190-194）-> **HTTP 403 + code -1**
  - 带状态码的处理器错误（records.ts:412 'Record not found'）-> **HTTP 404 + code 404**
- 影响：以 HTTP 状态码判成败的客户端会把「权限不足」当成功；以 code !== 0 判断的客户端在 404 分支拿到 code: 404 而非 -1。

### R10 [P2] 记录响应无 display_name，IDN 只在域名端点有
- 证据：toApiRecord（records.ts:35-49）不含 display_name，name 是适配器原样返回的 RR（aliyun/adapter.ts:20 normalizeRrName 只做 trim + '@' 兜底，见 providers/common.ts:33-36）。
- 对照：域名列表/详情对 Token 附加 display_name = toUnicode(name)（domains.ts:438；getDisplayDomain 见 utils/domain.ts:138-143）。
- root.ai.md:817 的「返回数据中包含 display_name 字段」在**记录**端点并不成立。

### R11 [P2] domain_match 传入单标签时过滤条件静默失效
- 证据：domain-query-builder.ts:192-213 —— 只有 parts.length >= 2 才生成后缀；parts.length === 1 时循环不执行，suffixes 为空，if (suffixes.length > 0) 为假，**不追加任何 WHERE 条件**。
- 影响：domain_match=localhost 之类输入退化为「不过滤」，返回该 Token 可见的全部域名（不跨租户，但答案错误）。

### R12 [P2] 有限域 Token 的分页与状态过滤参数被忽略
- 证据：domains.ts:228-234 getByIds(tokenAllowedDomains, { accountId, keyword, domainMatch }) —— 未传 domainStatus/domainType/pinnedDomainIds/page/pageSize；forTokenAuth 只加了 whereAccountEnabled()（domain-query-builder.ts:408-413）。
- 影响：带白名单的 Token 会拿到**已禁用域名**，domain_status=enabled 无效；与无白名单 Token 行为不一致。

---

## 四、近期工作流改动对本组端点的影响：无

已逐条核对相关文件的近期提交（git log -- server/src/routes/records.ts、-- server/src/routes/domains.ts）：

| 提交 | 对 records.ts 的改动 | 是否影响对外契约 |
|---|---|---|
| 188ffe6 fix(realtime): 记录事件改为按域名可见用户定向推送 | wsService.broadcast -> wsService.broadcastToUsers | **否**，仅推送通道，响应体未变 |
| 1d8e865 fix(workflow): 关闭审核团七项 P1 | 2 处 getDomainRecordInfo -> findRecordMeta（records.ts:761、832 附近，仅事件预读兜底） | **否** |
| 34179fb / 854d649 事件总线接入 | 新增 publishRecordEvent / hasWorkflowSubscribers 调用 | **否**，均在 sendSuccess 前后，不改响应 |

- 中间件顺序：records.ts 各路由的中间件链（authMiddleware -> requireTokenDomainPermission）在本轮改动中**未被修改**。
- 路由顺序：本组 4 个端点的定义顺序未变。唯一的路由顺序问题是**存量**的 /:id 遮蔽 /whois（R3），与工作流改动无关。
- 响应字段：toApiRecord（records.ts:30-50）未被近期提交触碰。
- 一处**未验证**项：actor.source 在 publishRecordEvent 中被硬编码为 'ui'（records.ts:490、739），外部 Token 调用同样记为 'ui'。只影响工作流事件元数据，不进入 HTTP 响应。

---

## 五、建议

### 必须修（对应 R1-R5）
1. **R1 幂等性**：在 records.ts 列表处理器里，对同时给出 subdomain + type 的结果做一次**本地精确过滤**（getSubdomain(r.Name, domain.name) === subdomain 全等比较，复用 records.ts:66-73 已有的 getSubdomain）。这是根治；退一步至少在 api.md 声明「subdomain 为上游模糊匹配，客户端需自行精确比对」。
2. **R2 分页**：把 pageSize 钳制与记录列表对齐到域名列表口径（Math.min(100, Math.max(1, parseInteger(pageSize) || 20))），并在 page/pageSize 非法时回退默认值而非把 NaN 传给适配器。
3. **R3 路由顺序**：把 router.get('/whois')（domains.ts:1471）移到 router.get('/:id')（domains.ts:594）之前；顺带处理 domains.ts:2 **已 import 但从未使用**的 requireDomainPermission（删除或接线）。
4. **R4 第二份文档**：给 docs/api-reference.md 二选一 —— 按实现全量更新，或在文件头标注「已废弃，见 api.md」并删除具体请求示例。
5. **R5/R6 Token 语义**：在 api.md 的 Token 章节明确写出「GET records 列表不受 allowed_domains 约束，仅受 Token 属主权限约束」「allowed_domains=[] 表示全部域名」「services 当前未强制执行」。若目标是硬隔离，给 records 列表补 requireTokenDomainPermission('domainId')，并把 requireServicePermission 接到写端点上。

### 应该修（对应 R7-R12）
6. **R7**：统一分页默认值，api.md:287 与 api.md:401 按实现（或实现按文档）改正。
7. **R8**：在 api.md 的 PUT 段补一句「name/type/value 为必填，不支持局部更新」；同步修正 api-reference.md:239-242 的错误示例。
8. **R9**：统一错误契约 —— 让 sendError 对客户端可见的 4xx 场景显式传状态码，使 body code 恒为 -1、HTTP 状态码表达类别（避免 body code 出现 404 这种混合值）。
9. **R10**：给 toApiRecord 增加 display_name（对 IDN 的 RR 做 toUnicode），或在 api.md 明确「display_name 仅域名端点提供」。
10. **R11**：whereDomainMatch 在 parts.length < 2 时应显式返回空结果（加 1 = 0 条件），而不是静默不加过滤。
11. **R12**：getByIds 分支补齐 domainStatus 过滤，或在 api.md 声明「带白名单的 Token 不支持 domain_status 过滤」。

### 建议补的回归测试（具体用例）
- GET records?subdomain=www&type=A 在适配器返回 [www, www2] 时，响应只应含 www（对应 R1）。
- GET records?pageSize=100000 与 ?pageSize= 两个请求都不应把越界值/NaN 传给适配器（对应 R2）。
- GET /api/domains/whois?domain=x&accountId=1 应命中 whois 处理器而不是 /:id（对应 R3）。
- Token + allowed_domains=[A] 请求域名 B 的记录列表：按当前实现会成功 —— 测试应把这一**现状**固定下来，避免将来无意变更（对应 R5）。
- domain_match=localhost 应返回空列表而非全部域名（对应 R11）。

---

## 六、未验证事项（明确声明）

- 未启动服务、未用真实 DDNS-Go 客户端做端到端联调；本文所有结论均来自源码静态阅读。
- 未验证：上游提供商对越界 pageSize 的具体反应（各厂商不同），因此 R2 只陈述「未钳制」这一事实，不推断具体失败形态。
- 未验证：findRecordMeta 兜底（lib/dns/record-lookup.ts）在外部 Token 场景下的额外上游调用次数。
- 未验证：Token 的 allowedDomains 在数据库为 NULL 时的实际取值（类型声明为 number[]，parseJson 未在本次阅读范围内确认），因此未对 hasDomainPermission 可能抛错的情形下结论。
