# 架构评审报告 · 代码审核团

| 项 | 内容 |
| --- | --- |
| 评审对象 | `ef66db6..cd539ad`（EO 站点级授权 / 事件广播收口 / 凭据复用双向声明 / DNS 模块分层重构） |
| 评审日期 | 2026-10-20 |
| 评审方式 | 四条独立评审线并行，各自只读通读代码、结论独立产出后汇总（不交叉引用） |
| 门禁口径 | `cd server && npx tsc --noEmit` = 0 错误；`npx vitest run` = 435 通过 / 45 文件。**注意**：`vitest.config.ts` 的 exclude 排除了 13 个历史失败文件，此绿非全覆盖 |

## 一、结论

**不建议按现状合入。** 主干设计站得住（站点级授权判定链、双向凭据声明、广播收件人口径），但存在 **1 条 P0**：

> `ext.write` 的授权口径被从「域名写权限」放宽到「账号可读（团队成员）」，形成一条可复现的团队内提权链。

另有 5 条 P1，其中 2 条与安全相关（特权缓存无失效钩子导致降权后仍推送；停用账号不过滤）。分层重构（`cd539ad`）**没有真正断开** providers 对 BAL/service 的依赖，只是把依赖链拉长了一层，且守卫测试是假阴性 —— 本次提交唯一的交付物就是这个架构保证，它不成立。

| 级别 | 数量 |
| --- | --- |
| P0 | 1 |
| P1 | 5 |
| P2 | 18 |
| 经核实无问题 | 17 |

## 二、P0

### P0-1 `ext.write` 授权口径从「域名写」降为「账号可读」，团队内可提权改写他人站点

- 位置：`server/src/lib/dns/origin-group-authorize.ts:66`（`_actionClass` 形参完全未使用）、`:87-92`
- 证据：读写两类动作共用同一条 `canAccessAccount`，而它就是 `routes/accounts.ts:20-27` 的 `canReadAccount` 副本（超管 / `created_by` / 团队成员）。
- 对照仓库既有写口径：账号级写见 `routes/accounts.ts:29-32` 的 `canManageAccount`（超管 或 role>=admin 且是创建者）；域名级写见 `workflow/actions/ext-guard.ts:17-18` 的 `allowedWriteDomainIds`。两者都要求写强于读，而钩子把写降成了读。
- 可复现链路（3 个 API 调用）：
  1. 攻击者 `role_level>=2`（`workflow/index.ts:76-79` 对 role>=2 发放含 `records.write` 的服务），是受害账号所属团队成员，但**不是创建者**、对该账号下任何域名都无 `domain_permissions` 行 —— 这种人在 HTTP 层连域名都读不到（`routes/domains.ts:88-111`）。
  2. `POST /api/workflows`（`routes/workflows.ts:78`，adminOnly）建单动作工作流，动作 = `ext.tencenteo.originGroup.replace`（`providers/tencenteo/extra.ts:178-192`，`actionClass: ext.write`、`risk: high`、`dslVisible: true`）。
  3. `POST /api/workflows/:id/run`（`routes/workflows.ts:268`）：合成事件 `domainId` 填**自己的**域名，动作参数 `domainId` 填受害域名。
  校验逐关放行：`auth.ts:133`（resource = 自己的域名，命中）→ `:184`（records.write）→ `:196`（`manual` 与 `record.changed` 都不在 `DOMAIN_TRIGGERS` 内，不拦写类）→ `ext.ts:52-53` 进钩子 → `canAccessAccount` 因团队成员为 true → `credentialSource` 为 `tencenteo` 时直接放行 → 整组覆盖受害站点源站组。
- 影响：按产品现有模型「只能看、不能管」的团队成员，可以走完 `acknowledgeReferenced` + `acknowledgeDataLoss`，直接改写任意站点的回源。
- 建议：钩子接收并使用 `actionClass`。`ext.read` 维持现状；`ext.write` 收紧为 `super_admin || (role >= ROLE_ADMIN && created_by === userId)`，与 `canManageAccount` 同口径。若产品确实要「团队成员 = 该账号全部 EdgeOne 站点完全控制」，必须在 `extra-types.ts` 与 `origin-group-authorize.ts` 注释里写明这条放大，并请产品确认后固化。

## 三、P1

### P1-1 特权缓存 60s 无生产失效钩子：降权/停用超管在窗口内继续收到他人域名事件（多算）

- 位置：`server/src/service/realtime-audience.ts:34`（TTL）、`:44`（cache）、`:46-48`（reset，仅测试调用）、`:88`（写缓存）、`:150`（超管无条件进入每个域名的收件人）
- 证据：`grep -rn resetRealtimeAudienceCache server/src` 只命中 `*.test.ts`，生产代码零调用；`routes/users.ts:231` 改 `role_level` / `status` 之后无失效调用。
- 影响：三条滞后叠加成外泄路径 —— ① 改角色后不失效；② 超管不按域名归属复核，无条件进每个域名的收件人；③ WebSocket 无服务端强制断开（`clients.delete` 只在 `close` / `error`），JWT 有效期 7d。刚被降权的用户最长 60s 内继续收到 `domain_*` / `record_*` / `domain_whois_updated`，payload 含域名名、到期时间、记录值。
- 建议：`routes/users.ts` 改 role/status 的分支同步调用 `resetRealtimeAudienceCache()`；同时把 `routes/audience.ts:32` 那份「现查不缓存」的实现与这里合并为一处，消除同一用户在两个通道上身份不一致。

### P1-2 非特权收件人完全不过滤停用账号：停用用户的残留连接继续收事件

- 位置：`realtime-audience.ts:137`（domain_permissions 行）、`:145`（团队成员）、`routes/audience.ts:81`（created_by）、`:86-87`（团队成员）、`routes/servicemonitor.ts:68-70`（监控 owner）
- 证据：本文件 `:71-72` 自述「停用账号不参与推送：登录态可能残留，宁可不推」，但该过滤只在 `loadPrivilegedUsers`（`:72`）里落实，上述五处 `add()` 都没有 status 复核。
- 影响：窗口不是 60s 而是「连接存活周期」。停用用户可继续收到其名下域名的记录变更、账号名/隧道信息、团队成员名单。
- 建议：把「有效用户集」提成单一函数（`loadPrivilegedUsers` 已具备形态，扩成 `getActiveUserIds()`），`add()` 统一过一遍；或在 `websocket.ts` 增加 `disconnectUser(userId)` 并在停用分支调用 —— 后者同时收窄 P1-1 的窗口。

### P1-3 providers 对 BAL/service 只是「字面量断开」，传递依赖仍在，守卫测试是假阴性

- 位置：`providers/tencenteo/extra.ts:11-12`、`providers/virtual/extra.ts:1`、`providers/tencenteo/meta-source.ts:3`、`lib/dns/origin-group-authorize.ts:1`、`lib/dns/account-context.ts:1`
- 证据：传递链 `providers/tencenteo/extra.ts → ../../origin-group-authorize → ../../db/bal/business-adapter`；`providers/virtual/extra.ts → ../../account-context → ../../service/dns-provider-service`。守卫只看两个字面量（`layer-dependency.test.ts:22-31` 的 `needle`，判定 `source.includes(rule.needle)`），所以永远绿。
- 影响：`cd539ad` 的唯一交付物就是这条架构保证，它不成立；且守卫测试会阻止后来者发现它。文档 `dns-core.md:438-448` 同样给出虚假保证。
- 建议：二选一 ——（a）真断开：`teoOpsForDomain` / `authorize` 改由 lib/dns 侧反注册注入（复用仓库已有的 `registerProviderMetaSource` 反转控制模式）；（b）承认 providers 可依赖 lib/dns 子功能，删掉对应文档段落与守卫测试，不要用假守卫占位。若保留守卫，至少改成基于 import 图的传递闭包。

### P1-4 依赖环没有解开，只是换了一条边

- 闭环：`providers/registry.ts:12 → tencenteo/extra.ts:12 → origin-group-authorize.ts:4 → origin-group-broker.ts:1 → account-context.ts:1 → service/dns-provider-service.ts:8 → DnsHelper.ts:3-10 → registry.ts`
- TDZ 判定：环**已核实存在**（静态 import 图）；「当前会崩」属推断（高置信）—— 今天所有入口都先求值 registry，顺序恰好安全；一旦任何模块把 `providers/{tencenteo,virtual}/extra` 当第一入口，`registry.ts:225` 会撞上未初始化的 const。
- 影响：仓库已踩过同形状的坑（`providers/internal.ts:66-70`、`DnsHelper.ts:19-25` 的惰性求值都是给它打的补丁），本次改动把环扩大了；仓库无任何环检测工具。
- 建议：治本是把 `extraCapabilities` 装配搬出 providers（lib/dns 侧 `registerExtraCapability(type, cap)`），registry 不再 import 任何 extra。止血：加一个只 import `providers/virtual/extra` 的独立 test 文件把加载顺序钉住。

### P1-5 文档两处模块路径指向已被本变更集删除的文件

- 位置：`docs/architecture/dns-core.md:421`（`providers/tencenteo/teo-ops.ts`）、`:599`（`providers/tencenteo/authorize.ts`）；对照 `:444` 已更新。
- 证据：两个文件在 `cd539ad` 中被重命名到 `lib/dns/origin-group-broker.ts` / `origin-group-authorize.ts`；`git blame` 显示 421 属 `061163ae`、599 属 `159831e6`，444 属 `cd539ad` —— 同一提交集改了 444 却漏了 421/599。
- 建议：分别改为 `lib/dns/origin-group-broker.ts` 与 `lib/dns/origin-group-authorize.ts`。

## 四、P2 清单

| # | 位置 | 问题 |
| --- | --- | --- |
| 1 | `realtime-audience.ts:136-140` vs `domains.ts:101-102` | 收件人只看 `domain_permissions` 有行、不看 `permission` 取值；写入侧 `teams.ts:694,961` 直接透传 body、schema 无 CHECK。写一行 `permission` 为 `deny` 即可让被授予者 HTTP 读不到却收到推送（**多算 = 外泄**） |
| 2 | `origin-group-broker.ts:64-73` 与 `account-context.ts:32-41` | `parseAccountConfig` 逐字节重复两份，broker 那份是死代码 |
| 3 | `origin-group-broker.ts:4`、`origin-group-authorize.ts:3` | 从 `providers/tencenteo/origin-group` 取 `OriginGroupError`，权威定义在 `origin-group-core.ts:39`；lib/dns 反向依赖 providers 只为拿一个中立错误类 |
| 4 | `layer-dependency.test.ts:22-31,38` | 守卫可绕过：`db/bal` 不带尾斜杠（`db/bal/index.ts` 是 barrel）、非 `.ts` 扩展名不扫、`__tests__` 整目录跳过；反向对注释里的 `db/bal/` 会误报 |
| 5 | `account-context.ts:56-58` + `broker.ts:87-92` | 抛裸 Error 后被 `catch {}` 压成 `DOMAIN_NOT_FOUND`；DB 故障/配置损坏被误报为「域名不存在」 |
| 6 | `origin-group-broker.ts:151-161` | tencenteo 路径静默忽略 `args.zoneId`；账号类型从 dnspod 换成 tencenteo 后，已保存的工作流参数无提示失效，会改打另一个站点 |
| 7 | `realtime-audience.ts:52-53` | 注释断言 `getAll()` 会带出 `password_hash`，实际 SELECT 列表不含该列 —— 虚构了一个 PII 风险 |
| 8 | `realtime-audience.ts:19,119` | 用绝对行号交叉引用 `domains.ts`，写入时已偏 2 行 |
| 9 | `providers/tencenteo/extra.ts:17` | 注释仍写「在 `./teo-ops` 里」，同文件 import 已改 |
| 10 | `realtime-audience.ts:121` vs `domains.ts:82` | `enabled === false` 在 number 字段上永不命中（死条件）；两处判据应统一为 `Number(account.enabled) === 0` |
| 11 | `realtime-audience.ts:28-30` | 把「当前写入范围之外」这类协作过程约束写进代码注释，把重复实现合理化成了设计决定 |
| 12 | `realtime-audience.test.ts:77` | `expect(audience).not.toContain(999)` 恒真（999 从未出现在 mock 输入）；`routes/audience.ts:45` 的 status 过滤无用例覆盖 |
| 13 | `origin-group-authorize.ts:22-23,56-63` | `zoneVisibility` 缓存 key 不含凭据指纹，账号密钥轮换后 60s 内仍放行；`resetZoneAuthorizationCache` 无生产调用点 |
| 14 | `origin-group-authorize.ts:71-74` | `Number(principal.id)` 对 token/system 身份会报「无法确定执行身份」，误导排查（当前生产只有 user 身份） |
| 15 | `broker.ts:121-128` | 凭据复用比对原始 `dns_accounts.type`，未走 `providerAlias` 归一化；历史别名行会被报成授权问题 |
| 16 | `credential-sharing.ts:22-29` | 「双向声明」实为同一文件两张表，启动校验只验自洽；性质是「集中式允许清单」，注释「必须改到别人的声明文件」表述偏强 |
| 17 | `actions/registry.ts:40-46` | 动作名唯一性只在测试期校验；注入同名动作可覆盖已有动作的 `actionClass` / `service` 与实现 |
| 18 | `engine.ts:409-441` + `workflow/index.ts:137-153` | 手动运行不走 `canAccessDomain`；超管运行他人工作流并填外部域名时，该域名名与记录值会原样进 `trigger_event`，对 owner 可见 |

## 五、经核实无问题（防止后续误改）

- **35 处广播确实全部收口，不是「丢了 17 处推送」**：diff 里 `-broadcast` 35 行、`+broadcastToUsers` 18 行，差额来自合并 helper（records 4 个调用点、servicemonitor 4、settings 5、teams 5、tunnels 2、users 3），import 与分发一一对应。**不要按差额去补回推送。**
- **「9 个文件、9 个提交」准确**：`git log 188ffe6^..e574308 -- server/src/routes` 正好 9 条。
- **三处顺序敏感点全部正确**：`domains.ts:1134` 先算后删、`accounts.ts:469-470`、`teams.ts:333-334`；`teams.ts:594-595` 在 `removeMember` 之前算收件人（有意为之）。
- **`toStoredTriggerEvent` 的脱敏条件与引擎实际产出完全对齐**：`no-domain-access` 是唯一「未通过租户校验却仍携带完整 event」的记录；`concurrent-run` 与 condition-skip 都在校验之后。落库口唯一。
- **`credentialSource` 为 `tencenteo` 时直接放行不可利用**：该分支下 zoneId 只来自 `domains.third_id`，用户传入的 `args.zoneId` 不参与；请求仍用该账号自己的密钥发往 TEO，越不出账号边界。
- **60 秒站点缓存跨用户共享安全**：它判定的是「凭据是否看得见站点」这一凭据属性，不是用户属性；用户维度每次重查 `canAccessAccount`；只有校验通过才写缓存，key 不可构造。
- **`instanceof TencenteoAdapter` 在日志 Proxy 下仍成立**：`createLoggingAdapter` 只定义 `get` trap 且只包 `ADAPTER_METHODS`，未定义 `getPrototypeOf`；`setZoneInfo` 副作用在首个 await 前落地。
- **ext 动作只有一条调用面**：MCP 对 workflow/dispatch/originGroup 零引用；`createFacade` 生产无调用点；11 条工作流路由全部 adminOnly，写路由再加 `requireJwtAuth`。
- **`meta/:source` 不是越权面**：先 `getUserAccessibleDomains` 做归属校验才把 domainId 交给候选源。
- **`canAccessEventDomain` 的 id>0 不回落名称是彻底的**：与 `auth.ts:133` 用同一谓词；唯一 id=0 的发布点是 ns.changed。
- **`OriginGroupError` 只有一份定义**（tencenteo 侧是纯 re-export），不要按「两个异常类导致漏 catch」去改；**无调用方按错误码分支**，不存在旧码迁移风险。
- **`getAccountAudienceUserIds` 的创建者旁路不带角色门槛是对的**：与 `accounts.ts:21` 的 `canReadAccount` 一致，与 domain 的「创建者需 role>=admin」是两套资源的不同规则，不是漂移。
- **`getDomainAudienceUserIds` 每条失败路径都返回空集**，没有一条会落到超管收尾；`loadPrivilegedUsers` 失败时 `at: 0` 使缓存恒失效，fail-closed 且不自锁。
- **`audit.ts:76` 的 `broadcastToRole` 是「少算」不是外泄**（`/audit*` 是 adminOnly，role=2 收不到），属既存口径差异。
- **`resource/job.ts:22` 的全员广播不构成数据面泄漏**：`collectSnapshot()` 只产出主机级指标，HTTP 侧 `/current` 也只要求 authMiddleware。
- **virtual 拿不到 dnspod 的密钥**：`CREDENTIAL_IMPORTS` 只有 `tencenteo`。
- **`role === 'super_admin'` 与 `targetRole === ROLE_SUPER` 都不是 bug**：`role` 列在读取侧被别名成数字 `role_level`。

## 六、建议的修复顺序

1. **P0-1**（授权口径）—— 先确认产品意图，再决定「收紧」还是「补注释固化」。这是唯一阻塞项。
2. **P1-1 / P1-2**（缓存失效 + 停用账号过滤）—— 同一批改动：加 `resetRealtimeAudienceCache` 生产调用点 + 统一「有效用户集」。
3. **P1-3 / P1-4**（分层与依赖环）—— 需要决策：(a) 真断开 vs (b) 撤回虚假保证。不建议维持现状。
4. **P1-5 + P2-9**（文档与注释指向已删文件）—— 一次改完。
5. 其余 P2 按 #1（permission 取值过滤）优先，它是唯一「多算 = 外泄」的 P2。

---

评审线分工：layering（分层与依赖方向）/ authz（鉴权模型与绕过面）/ boundary（数据边界、副作用与失败关闭）/ maint（可维护性、重复实现与文档一致性）。四条线独立产出，本文件为汇总，未对任何单条结论做取舍。
