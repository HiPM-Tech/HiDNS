# 后端评审 · C 端落地批次（fd855871..HEAD）

评审范围：`server/` 下 7 个文件（websocket / servicemonitor / domains / teams / serviceMonitor / business-adapter / record-types）。**基线 = HEAD cf97bc7f**；评审时工作区另有未提交的在途改动（WS 单用户连接上限、监控输入硬化、部分文案中文化），凡与结论相关的已在条目内逐条注明「在途是否覆盖」。只读评审，未改任何代码。

## 代码审核团评审

### 结论

本批次后端改动方向正确，未引入新的响应契约或分层违规；但存在 **1 条 P0（服务监控 PUT 缺授权：可跨租户改写他人 DNS 记录）**、**2 条 P1（WS 单用户连接数在 HEAD 无上限；WS 热路径退化为 O(n²)/O(m·n)）**、**3 条 P2**。**P0 修复前不建议合入**（P0 约 15 行；P1-2 在途已修，需随本批一起提交）。

### P0-1 · 服务监控 PUT 缺类型白名单与域名写授权 → 可跨租户改写他人 DNS 记录

- **file:line**：`server/src/routes/servicemonitor.ts:350,368-377`（对照 create `:246,269-286`）
- **问题**：create 对 `type` 做白名单（:269），并在 `type === 'dns_failover' && domainId` 时校验域名写权限（:280-286）；**PUT 只补了 `validateMonitorInput`，既无 type 白名单，也无域名写权限校验**，且 `type` / `domain_id` 原样落库（`server/src/service/serviceMonitor.ts:230-232`）。工作区在途改动同样没有补这两道校验（`grep getDomainAccess` 仍只有定义 + create 两处）。
- **影响**：任意登录用户可把自己名下的监控 PUT 成 `type='dns_failover'` + `domain_id=<他人域名>` + `config={recordName,recordType,backupValues,primaryValue}`。巡检执行 `checkFailover` → `updateFailoverDnsRecord`（`serviceMonitor.ts:639-665`，仅按 domainId 取域名与其账号凭据，**不含调用者身份校验**）→ 在受害者域名上 `updateRecord` / **`createRecord`**，即用受害者 DNS 账号的凭据写入或新建解析记录（可把 A 记录指向攻击者 IP）。附带：`type='ENDPOINT'` 这类非白名单值同样入库，监控恒为 `Unknown monitor type` 错误。
- **建议修复**：PUT 内补齐与 create 对称的两道校验（放在 `validateMonitorInput` 之前）：

        // server/src/routes/servicemonitor.ts, PUT /:id
        if (type !== undefined && !['ssl_certificate', 'endpoint', 'dns_failover'].includes(String(type))) {
          sendError(res, 'Invalid type. Must be one of: ssl_certificate, endpoint, dns_failover', 400);
          return;
        }
        const effectiveType = String(type ?? existing.type);
        const effectiveDomainId = domainId !== undefined ? domainId : existing.domainId;
        if (effectiveType === 'dns_failover' && effectiveDomainId) {
          const access = await getDomainAccess(Number(effectiveDomainId), req.user!.userId, normalizeRole(req.user!.role));
          if (!access.canWrite) {
            sendError(res, 'No write permission for the specified domain', 403);
            return;
          }
        }

  纵深防御：把 monitor 的 `userId` 传给 `checkFailover`/`updateFailoverDnsRecord`，写入前再校验域名归属于该用户，避免后续新入口再绕过。

### P1-2 · HEAD 上同一用户连接数无上限（多连接改造引入）

- **file:line**：`server/src/service/websocket.ts:121-132`（HEAD 版本，注册新客户端处）
- **问题**：改造前 `clients` 是 `Map<userId, client>`，新连接会顶掉旧连接，天然限 1 条/用户；改为 `Map<userId#seq, client>` 后**没有任何上限**。HEAD 中 `MAX_CONNECTIONS_PER_USER` 不存在（`git show HEAD:... | grep -c` = 0）。
- **影响**：任一已认证用户（含低权限 API Token）可开任意多条 WS 连接：每连接一份 `WSClient` + socket 缓冲，且消息限流是**按连接**的 10 msg/s（N 条连接即 10N msg/s）。自建实例上足以打满内存/CPU，属多连接改造带来的资源放大。
- **在途状态**：工作区未提交改动已加 `MAX_CONNECTIONS_PER_USER = 10` 与 `ws.close(4005)` 拒绝逻辑——**修法正确**，请确保与本批一起提交；提交后本条闭合。

### P1-3 · WS 热路径把 O(1) 查找换成全表扫描：扇出 O(m·n)、pong O(n²)

- **file:line**：`server/src/service/websocket.ts:43-50`（`socketsOf`）、`:167-171`（pong）、`:288-304`（`sendToClient`）、`:331-370`（`broadcastToUsers`）、`:252-264`（`handleDisconnect`）
- **问题**：丢弃「userId → client」单键查找后：`broadcastToUsers` 对每个收件人各扫一遍全表（O(m·n)）；`pong` 处理器对**每条 pong** 全表扫（一次心跳 N 条 ping → N 条 pong × N，O(N²)/30s；改造前是 O(1)）。
- **影响**：`broadcastToUsers` 是记录/域名/账号事件的唯一扇出通道（批量导入 100 条记录 = 100 次事件 × 收件人数 × 连接数）。多标签页把连接数放大后，千级连接时单次事件可达 10^5 量级比较，心跳周期可见 CPU 尖刺。
- **建议修复**：pong 用闭包里的 `client`（`ws.on('pong', () => { client.isAlive = true; })`）；再维护 `Map<number, Set<string>>` 的 userId → key 索引，`socketsOf` 由 O(n) 降为 O(k)，注册/删除/心跳终止/clear 同步维护。

### P2-4 · 监控关键字搜索未转义 LIKE 通配符

- **file:line**：`server/src/db/bal/business-adapter.ts:3049-3052,3066-3069`
- **问题**：`keyword` 直接包成「%kw%」后绑定，未转义 `%` / `_` / 反斜杠。
- **影响**：搜索 `%` 或 `_` 退化为「匹配全部」，过滤语义失效（仅限本人数据，非越权）；前导通配使 `name`/`target` 无法走索引。count 与 list 条件同源，`total` 不会偏差（这点没问题）。
- **建议修复**：绑定前转义 `%`、`_`、`\\`，SQL 用 `name LIKE ? ESCAPE '\\'`，count/list 两处同步。

### P2-5 · 续期 `provider_type` 兜底的两种语义漏洞

- **file:line**：`server/src/routes/domains.ts:1764-1778`（兜底）、`:1789-1800`（落库）
- **问题**：① 账号不存在时 `account?.type` 为 undefined，落到统一 `'Missing required fields'`——真实原因是账号不存在/无权访问，提示误导；② 显式传入 `provider_type` 时**不与账号实际 type 比对**，可把 `provider_type='aliyun'` 配到 cloudflare 账号上。
- **影响**：① C 端「添加续期域名」拿到与原因不符的 400；② 续期调度器按 `provider_type` 选执行器，与账号凭据错配 → 续期失败或对错误供应商发起调用。
- **建议修复**：查到账号后 `if (!account) return sendError(res, '账号不存在或无权访问', 404);`；若入参带 `provider_type` 且与 `account.type` 不一致则 400，或直接以 `account.type` 为准。

### P2-6 · dns_failover 的 config 未校验：缺 `backupValues` 时巡检每轮抛 TypeError

- **file:line**：`server/src/routes/servicemonitor.ts:30-77`（`validateMonitorInput`）、`server/src/service/serviceMonitor.ts:589`（`for (const backupValue of config.backupValues)`）
- **问题**：真正决定「写哪条记录、写什么值」的三个键（`recordName` / `recordType` / `backupValues`）完全未校验。`backupValues` 缺省时该行对 undefined 迭代 → 每轮巡检抛 `TypeError: config.backupValues is not iterable`（被任务层兜住 → 监控恒 error）；`recordType` 为任意字符串会直达 `updateFailoverDnsRecord` → `createRecord(..., 'A', 'not-an-ip')`。工作区在途改动补了 `checkMethod`/`expectedBody`/`checkPath` 硬化，**未覆盖这三个键**。
- **建议修复**：`type === 'dns_failover'` 时校验 `Array.isArray(cfg.backupValues) && cfg.backupValues.length > 0`、`typeof cfg.recordName === 'string'`、`cfg.recordType` ∈ {A, AAAA, CNAME}，且每个 backupValue 过一遍现有 `validateRecordValue`；`for...of` 处加 `(config.backupValues ?? [])` 兜底。

### 经核实无问题（本批）

1. `routes/servicemonitor.ts:188-196` 关键字搜索的参数化与 count/list 同源，`total` 不会与新过滤条件脱节。
2. `routes/teams.ts:157-166,289-300` 团队名 1–50 **同时覆盖 create 与 update**（trim 后判空与超长），update 不构成旁路。
3. `lib/dns/record-types.ts:185-201,225-229` IPv6 校验改为「URL 解析 + 字符集」判定，修掉大小写规范化误判（`2001:DB8::1` 现在合法），且不接受 zone id。
4. `routes/servicemonitor.ts:269,280-286` create 路径的类型白名单与故障转移域名授权**本身正确**（问题只在 PUT 不对称，见 P0-1）。
5. `config/env.ts:33,62-76` 与 `routes/init.ts` 的 `hasExistingData`（MySQL/PG 分支见 `business-adapter.ts:2162-2251`，均按 users/domains 行数判定）**不在本批 diff 内**。现有语义为「启动时已存在的进程环境变量优先于 data/.env」，因此向导写入在无同名变量时生效、重启后被进程环境覆盖——属预期行为，建议在向导 UI 明示一行（P3，非本批引入）。

### 建议合入顺序

P0-1（PUT 授权 + 白名单）→ P1-2（把在途的连接上限一起提交）→ P1-3（WS 索引）→ P2-6（缺键崩溃）→ P2-5 → P2-4。P0/P1 修完即可合入，P2 可随后续小批次。


### 修复状态（执行层回填，提交 `436443f9`）

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| P0 PUT 缺 type 白名单与域名写权限 | ✅ 已修 | PUT 补 type 枚举 + dns_failover 必须 bind 且有写权限；实测 member PUT 他人域名 → 403 |
| P1 WS 单用户无连接上限 | ✅ 已修 | 每用户 10 条上限（超出 4005）+ userIndex 消除全表扫描 |
| P1 socketsOf O(n) 扫描 | ✅ 已修 | userIndex: Map<userId, Set<key>>，心跳/广播/断开均为 O(该用户连接数) |
| P2 LIKE 通配符 | ✅ 已修 | keyword 转义 % _ \ 并加 ESCAPE |
| P2 provider_type 兜底误导 | ✅ 已修 | 账号不存在 → 404；非超管校验账号归属 → 403；provider_type 与账号类型不一致 → 400 |
| P2 dns_failover config 未校验 | ✅ 已修 | 校验 recordName/recordType/backupValues/ttl；config 传字符串直接 400 |

### 第二轮验收（修复后复核）

| 评审 | 判定 | 说明 |
| --- | --- | --- |
| be-constraint-review | ✅ 通过（P0=0/P1=0） | P0 越权链闭合；WS 上限/索引对称；续期归属 PASS；非 failover domain_id 记 P2 |
| fe-arch-review | ✅ 通过（P0=0/P1=0） | 4005 停止重连、enabled/config 回填、审计列宽、pt-phi-8、防抖、MCP 用词均 PASS |
| adversarial-auditor | ✅ 通过（P0=0/P1=0） | 两道式改类型/置空/字符串 id 均无法绕过；续期归属 PASS |
| design-critic | ✅ 通过（阻塞项 274f3780 后复核） | 实测 POST/PUT type=endpoint + domain_id=999 → 200 且回读 domain_id=null |

最终：**四位评审一致通过，可合入**。

## 2.3.0 重构目标核对

核对人：be（后端）。范围：00-PLAN §1 目标 2（API 语义收敛）、目标 3（API 子模块）、DNS 适配器语义。**基线对照法**：用 `git cat-file -e v2.3.0:<path>` 与 `git show v2.3.0:<file>` 区分「2.3.0 时点已达成」与「2.3.1 收尾后才达成」，HEAD 现状另行 grep/实跑。门禁实跑：`tsc --noEmit` = 0，`vitest run` = **638 passed**。

### 目标 2 · API 语义收敛 —— **部分达成**

- **2-1 [达成 · 2.3.0 时点]** 信封与 `code === HTTP`：v2.3.0 的 `routes/__tests__/error-contract.test.ts` 已含三条断言（禁 `code:-1`、`res.status(N)` 块内 code 必须等于 N、裸 `res.json({success|error|message})` 扫描）；v2.3.0 的 `middleware/auth.ts` 中 `code: -1` 计数已为 0。当前我独立复扫 `routes/ + middleware/ + api/` 共 **183 处**手写信封：`code ≠ status` **0 处**、有 code 无 msg **0 处**。非 JSON / 边角路径：未知 API 路径 JSON 404（`app.ts:504-508`）、请求体过大 413（`middleware/errorHandler.ts:48-49`）、限流 429 全 JSON（`middleware/rateLimit.ts:6-8`）、上游失败 502 共 3 处（如 `routes/workflows.ts:215`）。
- **2-2 [未达成 · P2]** 畸形 JSON 请求体映射成 500 而非 400：`errorHandler.ts` 只处理 `entity.too.large`，无 `entity.parse.failed` / `SyntaxError` 分支，body-parser 解析错误落入兜底 500。
- **2-3 [达成]** 分页口径：`utils/http.ts:52-67` 的 `parsePagination` + 6 个端点显式声明；`docs/api.md:17-26` 登记 4 类例外（grouped 1000 / audit+logs 50-200 / resource-monitor 60-1440）。`/api/accounts`、`/api/mcp/audit-logs` 实测 20/100 与标准一致但未登记（P3）。
- **2-4 [未达成 · P1]** `allowed_services` 只有声明、无执行点：`service/token.ts:174-176` 的 `hasServicePermission` 唯一调用方是 `middleware/auth.ts:69` 的 `requireServicePermission`，而 `grep -rl requireServicePermission routes/` = **0**；`service/token-policy.ts` 自述「服务级门禁尚未全面接线」。与 `docs/api.md:775` 承诺的「细粒度服务权限」不符：用户按服务收窄令牌后实际不受任何限制。
- **2-5 [部分达成 · P2]** 幂等：仅 `root.ai.md:663` 要求**外部适配器**先按 subdomain+type 查询再 upsert；服务端无 Idempotency-Key / 去重实现（`grep -rn idempot server/src` 0 命中），也无契约用例。
- **2-6 [达成]** 域名级权限口径：`docs/api.md:17-27` 的 allowed_domains 语义表与实现一致（`middleware/auth.ts:159-175`、`service/token.ts:181-185`：null 与空数组均表示不限制，白名单需显式列 ID）；`requireTokenDomainPermission` 覆盖 records/domains 两个路由文件；`noTokenAuth` 7 个文件、`adminOnly` 10 个文件。

### 目标 3 · API 注册独立成子模块 —— **达成（2.3.0 时点已达成）**

- **3-1 [达成]** `server/src/api/` 在 **v2.3.0 标签**即已存在（`git cat-file -e v2.3.0:server/src/api/index.ts` 命中；模块数 23，与当前一致）；`app.ts` 只剩 `app.use('/api/docs')` 一处（v2.3.0 同为 1）；`api/registry.ts` 有 6 条 fail-fast（id/prefix 唯一、前缀格式、description、probe 归属），前缀唯一性按「小写 + 参数名折叠」归一；门禁三态与豁免**派生自模块声明**（`api/init-gate.ts:28-34` 取 `getExemptPrefixes` 与 `closedStateProbes`），`api/__tests__/api-layer.test.ts` 断言「豁免由模块派生」「大小写/参数名不影响唯一性」「三态放行矩阵」。
- **3-2 [P3]** 26 个 `routes/*.ts` 中仅 `routes/audience.ts` 未进清单，但它是收件人工具函数（被 domains/accounts/users 引用）、不是 Router —— 建议移入 `service/` 或 `lib/`。

### DNS 适配器语义 —— **2.3.0 时点未达成；HEAD 达成（redirect 空转）**

- **A-1 [2.3.0 未达成 → 2.3.1 达成]** 线路模型：v2.3.0 时 `service/providerLines.ts`、`providerLinesJob.ts` 均**不存在**，`registry.ts` 的 `lineSource:` 计数为 **0**；当前有 27 条 lineSource/defaultLine，`providerLines.ts:7-9` TTL 3600s + 失败冷却 300s、:76-78 失败只返回默认线路、:107-123 只为「有启用账号」的 provider 排队；`providerLinesJob.ts:29-32` 只拉 dynamic、:37-39 走 taskManager（timeout 120s + 同 ID 去重），并在 `app.ts:610,725`（含降级重连分支）启动。
- **A-2 [2.3.0 未达成 → 2.3.1 达成]** 2.1 语义不变量：`resolveCreatedRecordId`（`lib/dns/providers/common.ts:22`）被 powerdns:245 / vps8:208 使用；`getRecordLines` 失败抛错（dnsla:275-277）；读接口 fail-closed（`service/dns-provider-service.ts:137-139`：空结果 + getError() → 抛错）；`lib/dns/__tests__/adapter-contract.test.ts` 用源码守卫禁止用 'success' 充当 RecordId、禁止编造线路列表。
- **A-3 [达成但空转 · P3]** 重定向能力位：26 家**全部** `redirect: false`（`grep -c 'redirect: true'` = 0），且 **0 个适配器实现 setRecordRedirect**（`grep -rln setRecordRedirect lib/dns/providers/*/adapter.ts` = 0）→ `routes/records.ts:593-595,902-904` 的 501 分支与整条 redirect 链路**不可达**；该能力也未在 `/api/providers` 暴露、前端无消费点。属预留能力，建议在 root.ai.md §2.3 注明「当前无 provider 声明 true」。
- **A-4 [达成]** 能力位执行：`routes/records.ts:61-71` 汇总 providerCapability，proxiable(:106)、remark(:584)、weight(:586)、status(:1038)、recordTypes(:119-120) 均有执行点。
- **A-5 [达成 · P3]** 日志工厂与 HTTP 通道：27 个 provider 文件使用 internal 工厂（dnshe/auth.ts:1、dpdns_reverse/adapter.ts:1 已改）；`lib/dns/providers/common.ts:11` 仍 createLogger('DNS')（基础设施文件、非具体 provider，建议注明豁免）；`grep 'fetch(' lib/dns/providers/` 除 fetchWithFallback 外 0 命中。

### 结论（目标 2/3 + 适配器）

- 目标 2：**部分达成** —— 信封/错误码/分页/域名权限在 2.3.0 时点已达成；**服务级权限（allowed_services）无执行点**、幂等仅有客户端约定、畸形 JSON 落 500。
- 目标 3：**达成**，且 **2.3.0 时点即达成**（非 2.3.1 补丁）。
- 适配器语义：**2.3.0 时点未达成**（2.1/2.2/2.3 全部来自 v2.3.0 之后的 03bd1c08 / 9e6d9070 / 57f2292f / 9fd03ac6）；**HEAD 达成**，唯一遗留是 redirect 能力位全仓 false + 零实现，链路空转。
