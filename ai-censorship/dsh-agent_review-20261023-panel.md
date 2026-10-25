# 代码审核团报告（8 线并行 · 隐性问题专项）

| 项 | 内容 |
| --- | --- |
| 目标 | 按 `root.ai.md` 大方向，对全仓做一次「隐性问题」专项审查（语义/契约层缺陷，非风格问题） |
| 方法 | 8 条互斥范围的独立评审线并行（A–F 首轮 + G/H 补盲区；各自只读代码、独立产出），主审逐条抽检证据后合并去重 |
| 日期 | 2026-10-23 |
| 原始发现 | 96 条（P0 8 / P1 63 / P2 25） |
| 去重后 | **86 条**（P0 7 / P1 58 / P2 21） |
| 分线报告 | `ai-censorship/evidence/panel-20261023-{A,B,C,D,E,F,G,H}.md`（8 份全部交付，约 250 KB） |
| 抽检 | 主审独立复核 11 条关键论断 + 7 条 P0 全部复核，均成立（见 §八） |
| 覆盖盲区补线 | H 线（构建 / CI / 发布流程）与 G 线（日志体系与公共设施）**均已并入**（§三 T9–T12、§四 G-07/08/10/H-12） |

## 一、结论

**一、** 本仓库的隐性问题不是零散 bug，而是**同一个形状反复出现**：语义被写下来了（注释、类型、能力位、开关、参数），但没有**单一执行点**去落实它。于是每一层各自解释，缺省值各不相同，失败被折叠成"空值/成功"。

12 个可举证的「声明了但没人执行」：

| 声明 | 实际 |
| --- | --- |
| `isInitSurfaceOpen()` 表达 fail-closed | 生产代码零调用，只被 import（`app.ts:207`）与测试引用 |
| `TaskOptions.concurrency` | 全仓零读取，真实并发恒为全局 3；8 处调用方注释"串行执行"是假的 |
| `DnsCapabilities` 能力位 | 服务端无校验：`capabilities.` 全仓仅 11 处命中，且只用于 `recordTypes` / `renewal` / `cnameFlattening`，`status` / `weight` / `proxiable` / `redirect` 无人读 |
| `dropTablePolicy` | 默认 `'always'`，唯一调用点不传参 |
| `DSM_BACKUP_REQUIRED` | 同一开关在备份器与协调器里默认值相反 |
| `HIDNS_DISABLE_VIRTUAL_PROVIDER` | 与 `availability.ts` 的 `ENABLE` 语义相反 |
| `canSelectProxy` | 两个分支都返回 `true`，门禁从未生效 |
| `enabled` 字段 | 5 种归一化、3 套表示，同文件两处读法相反 |
| `sendError(res, msg)` | 缺省 HTTP **200**，120 处错误路径"成功返回" |
| PUT 记录的 `status` | 解构后从不使用，仍回 `code:0` |
| `allowed_services` | 创建令牌时硬编码 `['*']`，PUT 却能改 |
| `proxiable` 能力位 | 前端零消费，代理判定按 `providerType` 硬编码 |

**二、** 因此修复策略不是"逐条打补丁"，而是**先接线、再收口、后建契约测试**：把每条语义收敛到唯一执行点（归一化函数 / 能力位 / 校验中间件），否则同一个洞会在 22 个 provider、8 个定时任务、3 个表单里各长一遍。

**三、** 安全面上有 1 条必须先处理的链（P0-1）：初始化入口守卫没接线，数据库不可达 + 无标记文件时 `/api/init/database` 仍可改库、`/admin` 仍可建管理员——正是 `root.ai.md` §数据库可用性判定 点名要切断的"未授权接管通道"。

## 二、P0（7 条，去重合并后）

### P0-1 初始化入口守卫未接线：数据库不可达时初始化面仍开放（C-01 + A-2 + A-9 + F-7）

- 位置：`server/src/routes/init.ts:49-58`、`server/src/service/systemState.ts:71-73`、`server/src/db/bal/business-adapter.ts:2146,2189,2236`、`server/src/routes/init.ts:207-210`
- 证据（主审已复核）：`requireInitSurface` 只判 `isSystemInitialized()`；`isInitSurfaceOpen()` 是唯一 fail-closed 实现，但 `grep -rn isInitSurfaceOpen server/src` 只有 `app.ts:207` 的 import 与测试；`/admin` 分支自己查了 unreachable 返回 503，`/database` 没有；BAL 的连接测试 `catch {}` 后仍返回 `success:true, hasExistingData:false`；`/init/database` 把连接异常注释成"新数据库的正常情况"继续执行。
- 影响：全新部署（无 `data/.initialized`）且数据库暂时不可达时，任何能访问实例的人可用请求体里的数据库配置重建连接，再创建管理员 → 接管。`root.ai.md:482-496` 明确要求"unreachable ≠ uninitialized"且状态变更端点必须永久关闭。
- 修复：`requireInitSurface` 改判 `isInitSurfaceOpen()`（三态：仅 `uninitialized` 开放）；`/database`、`/admin` 统一走该守卫；BAL 的连接测试失败必须抛；`/status` 的异常不得折叠为 `code:0, initialized:false`。

### P0-2 DSM 每次启动静默 DROP schema 之外的表（A-1）

- 位置：`server/src/db/dsm/schema-reconciler.ts:434`（`dropTablePolicy = 'always'`）、`:470-471`、`server/src/db/dsm/init-dsm.ts:28`（只传 `dryRun`）
- 证据（已复核）：默认值 `'always'`，唯一调用点不传参；删除路径只有一行 `log.warn`，无清单、无 dry-run 提示；`app.ts` 的 5 秒重连循环会反复触发。
- 影响：同库内非 DSM 管理的表（历史表、外部工具表、误建表）在启动时被删除且只留 warn。这是**不可逆的数据面损失**。
- 修复：默认改 `'never'`，删除必须在显式配置 + 打印完整清单 + 备份成功（P1 的 `DSM_BACKUP_REQUIRED` 先修）后才执行。

### P0-3 初始化标记持久化与数据目录解析脱钩（A-2）

- 位置：`server/src/service/systemState.ts:24-45`（`path.resolve(process.cwd(), 'data', '.initialized')`）、`:108-112`（`markInitialized` 返回 `void`）；对照 `server/src/db/dal/config.ts:124-148`（四级解析：`DB_PATH` → `HIDNS_DATA_DIR` → 二进制环境 APPDATA/XDG → cwd）
- 证据（已复核）：两者各自解析，二进制部署（SEA）下标记可能落在不可写目录；`writeMarker` 失败只 `log.error`，调用方无法区分"已落盘/仅内存"。
- 影响：`root.ai.md:485` 要求"必须持久化、禁止仅依赖内存"，否则重启且数据库不可达时初始化入口重新打开——与 P0-1 串联即形成接管链。
- 修复：标记路径复用 `resolveDefaultDbPath()` 的目录部分（或引入统一的 `resolveDataDir()`）；`markInitialized()` 返回 `boolean` 或抛错，失败即降级并拒绝开放初始化面。

### P0-4 读接口把错误折叠成空集，并被持久化为 `record_count=0`（B-02）

- 位置：`server/src/lib/dns/DnsInterface.ts:37-47`；同类 92 处（如 `cloudflare/adapter.ts:194,203,220`、`aliyun/adapter.ts:111-114`）；消费点 `server/src/service/recordCountCache.ts:19-23`
- 证据（已复核）：`catch` 返回 `{ total: 0, list: [] }`；`refreshDomainRecordCount` 直接 `DomainOperations.updateRecordCount(domain.id, result.total)`，不区分"真的是 0 条"与"查询失败"。全仓唯一正确样板是 `dnspod/adapter.ts:167-177`（区分空列表与错误并重抛）。
- 影响：一次上游抖动就把域名记录数写成 0（前端展示、容量统计、监控阈值全部被污染），且无任何告警。
- 修复：读接口增加失败通道（抛错或 `Result`），`recordCountCache` 只在成功时写库；以 dnspod 为模板向内收敛，**不要**反过来把 dnspod 拉平。

### P0-5 RecordId 契约破裂：字面量 `'success'` 当记录 ID，非法 ID 变 0 号记录（B-03）

- 位置：`bt/adapter.ts:206`、`powerdns/adapter.ts:244`（`return 'success'`）；`dnspod/adapter.ts:277`、`dnshe/adapter.ts:365`、`rainyun/adapter.ts:337`（`toNumber(recordId, 0)`）
- 证据（已复核）：`addDomainRecord` 的返回类型是 `Promise<string | null>`，但返回的是状态字符串；路由随即用该值 `getDomainRecordInfo(recordId)` 与推送事件，后续 `DELETE /records/:recordId` 会带着 `success` 或 `0` 去删记录。
- 影响：误删/删不掉/删错记录（`0` 号记录）——数据面不可逆操作。
- 修复：创建后必须回查真实 ID；无法取得则返回 `null` 并由路由报错；`toNumber(recordId, 0)` 一律改为"非法即失败"。

### P0-6 `line` 一字段多义 + 线路 ID 空间不一致（B-01 + C-11 + D-02 + E-01 + F-3，5 条线独立命中）

- 位置：`routes/records.ts:470-474,719-723`、`client/src/components/RecordForm.tsx:143,159,330,340`、`workflow/actions/dns/record.ts:114,194,127`、`providers/powerdns/adapter.ts:175` vs `:393`、`providers/namesilo/adapter.ts:191` vs `:179`、`providers/cloudflare/adapter.ts:354`、`aliyunesa/adapter.ts:176`
- 证据（已复核）：同一字段同时表示"线路 ID"、"Cloudflare/AliyunESA 代理开关（0/1）"、"被单向改写的别名"；powerdns 读回 `Line:'default'` 而选项 id 是 `'0'`，namesilo 同型；工作流硬编码 `'0'` 且 update 不传 `line`（阿里云 update 默认 ttl=600、line 默认）→ "只改值"会把记录从电信/联通搬回默认线路并重置 TTL。
- 影响：静默改写用户线路（多数提供商创建后不可改），Cloudflare 代理永远打不开或被动关闭；评审团 5 条线从 5 个方向独立撞到同一处，说明这是系统级根因。
- 修复：见 §七 阶段 2（API 拆 `proxied`、`resolveLine()` 归一化、能力位 `lineEditable/defaultLineId`）。

### P0-7 账号凭据掩码 `'***'` 被原样回传，编辑账号必失败或凭据被覆盖（D-01）

- 位置：`server/src/routes/accounts.ts:137,316`（GET 掩码）→ `client/src/pages/Accounts.tsx:48-55`（`String(value || '')` 保留 `'***'`）→ `server/src/routes/accounts.ts:375-385`（PUT 先跑 `createAdapter(config).check()`，再原样落库）
- 证据（已复核）：`check()` 失败返回 `Credential check failed`；若某 provider 的 `check()` 只做形式校验，`'***'` 会真正写入数据库，凭据永久损坏。
- 影响：默认配置下"编辑账号"直接不可用；边角 provider 上则是不可逆凭据丢失。
- 修复：服务端识别掩码哨兵（`'***'` 表示"未修改"），合并时跳过这些键；前端不要回传未修改的掩码字段；`docs/api.md` 写明该语义。

## 三、P1（58 条，按 12 个主题归并）

> 每条详情见分线报告对应编号。主题内部按影响排序。

| 主题 | 条目（编号） | 一句话 |
| --- | --- | --- |
| T1 错误折叠成正常值 | A-7、A-8、A-9、B-04、B-09、D-06、E-07、E-10、F-2（P2 侧的 A-11、F-7 见 §四） | 迁移失败只 log、探测失败当"未建立"、线路失败编造 5 条假 viewId、通知恒 `sent:true`、PUT 记录丢弃 `status`、探测不可判定即真切 DNS |
| T2 声明未接线 | E-03、B-05、A-3、B-12、D-02 | `concurrency` 零读取、能力位零校验、`DSM_BACKUP_REQUIRED` 两处相反默认、`HIDNS_DISABLE_VIRTUAL_PROVIDER` 与 `ENABLE` 相反、`canSelectProxy` 恒真 |
| T3 同一语义多套归一化 | D-08、E-06、B-11、D-03、F-12、C-04 | `enabled` 5 种读法/3 套表示、TTL/MX/Weight 哨兵（7207、MX 与 Weight 同源）、默认线路三种写法、分页三套口径、Token 域名白名单两份实现且空数组=全放行 |
| T4 两份实现 / 互相遮蔽 | C-07、F-4、D-11、E-11、A-5、B-08 | 两个 router 同挂 `/api/security`（`securityPolicy` 4 个端点永久不可达）、`token.ts` 第二份权限判定、两份 `toXxx` 工具、DSM 判定查 `hidns-dsm` 而写入只写 `hidns`、别名归一化存在但工厂不用 |
| T5 安全边界 | C-02、C-03、C-05、C-06、C-08、C-09、F-1 | `/API/...` 大小写绕过 503、`sendError` 默认 200（120 处）、RDAP 限流凭 Bearer 头存在即跳过、XFF 可伪造影响登录限流、`POST /smtp/test` 无 Token 限制、`/providers/:type/icon` 未鉴权且可刷日志、创建令牌硬编码 `allowed_services:['*']` |
| T6 任务/调度/资源 | E-02、E-04、E-05、E-08、E-09、E-12、A-4、A-6 | 超时释放任务 ID 导致同 ID 并发双跑、任务 ID 拼 `Date.now()` 破坏互斥、`groupedCache` 读改写互相覆盖、FAILOVER 只存内存、环形缓冲当累计计数、超时定时器未清、备份目标取 `process.env` 与真实连接不一致、会话级 `SET FOREIGN_KEY_CHECKS` 打在池上 |
| T7 客户端 | D-04、D-05、D-07、D-09 | 每次渲染拆建 WebSocket、7 处直连 fetch 且发出 `Bearer null`、三个表单绕过 `useFormSync`、乐观更新写在错误 queryKey（空操作） |
| T8 契约/文档 | F-5、F-8、F-9、F-10、F-11 | `docs/api.md` 称 `/api/system/*` 免鉴权（实际全鉴权）、`root.ai.md` 路由清单/页面路由/"22 个提供商"三处过时、客户端手抄能力模型且漏 `extraCapabilities` |
| T9 门禁结构性假绿 | H-02、H-03、H-04、H-05、H-06 | Test Summary 漏判 `lint-and-build`/`e2e-test`（红也打印 All tests passed）、test-database 六项中四项被 `continue-on-error`/`\|\| true` 折叠、覆盖率上传指向永不生成的文件、PR 检查承诺 6 项实跑 1 项、4 个腐化用例被永久 `exclude` |
| T10 发布链路与规范 8 步不对齐 | H-07、H-08、H-09、H-10 | 产物门禁漏 `build_windows_arm`、版本只读根 `package.json` 且无 tag 校验/checkout 不 pin、10 处构建 `--no-frozen-lockfile` 且镜像未固定 pnpm/Node、两条 docker 发布路径共用 `latest` |
| T11 规范强制项无执行点 | H-01、H-11、G-09 | `validateEnv()` 经 `getDbConfig()`（全仓零调用）成为死代码 → MySQL/PG 必填参数与未设 `JWT_SECRET` 都不拦启动；`root.ai.md:733` 强制的 `check_i18n_simple.js` 在 CI/scripts/package.json 零引用；`DB_PATH` 文档默认 `./HiDNS.db`、实际 `{cwd}/data/hidns.db` |
| T12 日志与公共设施 | G-01、G-02、G-03、G-04、G-05、G-06 | 日志限流无中央原语（NS 监控 4N 行/5 分钟、DB 重连无重入保护）；后台任务唯一失败出口只传 `err.message`；INFO/DEBUG 不再输出 `[函数名][L行号]`（与 §129-142 格式契约冲突）；代理失败回退直连后调用方无法区分；socks5 依赖缺失时静默改用 http 代理；`whois/scheduler` 错误日志连 `error` 都不传 |

## 四、P2（21 条）

| 编号 | 位置 | 问题 |
| --- | --- | --- |
| A-11 | `db/connection.ts:65-80` | 未知驱动类型 `return false`，被 probe 折叠成 `uninitialized`（fail-open） |
| A-12 | `dsm/migration-manager.ts:348-355` | 版本记录谓词恒假（`version LIKE 'DSM-%'` vs 实际写 schemaHash） |
| B-11 | 多家 adapter | TTL/MX/Weight 哨兵：`7207` 魔法值、MX 与 Weight 共用上游字段、`ttl=1` 表"自动"、`getMinTTL` 假查询 |
| B-12 | `registry.ts:242` 等 | 注册表/日志入口漂移：环境变量名相反、`STUB_TYPES` 恒空、`createLogger('DNS')` 12 处、导出未实现的 DoT 代理桩 |
| C-10 | `middleware/errorHandler.ts:50-56` | 全局错误响应 `{code,message,timestamp}` 与 `{code,data,msg}` 契约不同，且不检查 `headersSent` |
| C-12 | `middleware/requestLogger.ts:46-55` | `res.json` 内部调用 `res.send`，每个 JSON 响应记两遍日志 |
| D-10 | `pages/Records.tsx:91` | `/record-types` 失败时静默降级为硬编码类型表，且硬编码 `cloudflare` |
| D-11 | `utils/typeConverters.ts:13` / `utils/formHelpers.ts:52` | 同一组类型转换两份实现，默认值语义不同 |
| D-12 | `api/accounts.ts:25` | `list()` 返回联合类型，3 处调用点各自手写归一化 |
| E-11 | `whois/scheduler.ts:42-51` | 重连失败静默 `return`，任务被记成 completed；重连逻辑在 `serviceMonitorJob` 重复 |
| E-12 | `taskManager.ts:260-276` | 失败/重试路径不清超时定时器，残留最长 30 分钟，拖住优雅退出 |
| F-7 | `routes/init.ts:106-118` | 探测失败压成 `initialized:false` 的 `code:0`；`client/src/api/init.ts:17` 还丢了 `dbReachable` |
| F-8 | `root.ai.md:366-388` | 路由清单三处漂移（`/api/email-templates` 已停用、缺 `/api/resource-monitor`、`/api/settings` 语义写反） |
| F-9 | `root.ai.md:757-775` | 页面路由整体过时（登录是 `/login`、业务页在 `/dash/*`、MCP 授权是 `/oauth/authorize`） |
| F-10 | `root.ai.md:296,638` | "22 个提供商/22 个图标"过时：定义 26 条（注册 25），图标 25/20 两个来源 |
| F-11 | `client/src/api/types.ts:16-35` | 客户端手抄能力模型、漏 `extraCapabilities`；`proxiable` 无人消费 |
| F-12 | `routes/records.ts:191` | 分页默认值/上限三套口径，records 无上限透传上游 |
| H-12 | `.github/workflows/docs-deploy.yml:245-247,279-488` + `docs/index.html:7` | 存在第二套文档站实现，每次部署覆盖 docsify 入口；单页转换失败只 `console.error`，发布仍绿 |
| G-07 | `proxy-http.ts:118,169,259,317` + `:288,298,339` | 超时三份实现且直连 `fetch` 完全无超时，`RequestOptions.timeout` 未接线 |
| G-08 | `config/env.ts:37,45` | `.env` 无 override、`data/.env` 有 override → 实际优先级 `data/.env > process.env > .env`，与 §320 及文件头注释相反 |
| G-10 | `utils/domain.ts:122-132` vs `whois/domain-utils.ts:30-55`；`utils/validation.ts:36-82` | `getRootDomain` 两份实现结论不同，`utils/dns.ts:30` 桶文件导出的恰是取末两段那份；`isValidDomain` 实测接受 `example.com/admin`；`isValidPassword` 与 `securityPolicy.ts:170` 两份 |

## 五、跨线同源图谱

| 根因 | 被几条线独立命中 | 命中条目 |
| --- | --- | --- |
| `line` 语义多义 / 线路 ID 空间不一致 | **5** | B-01、C-11、D-02、E-01、F-3 |
| 失败被折叠成"空值/成功" | **6** | A-7、A-8、A-9、B-02、B-04、D-06、E-07、F-2、F-7 |
| 同一语义多套归一化（缺单点） | **4** | B-11、C-04、D-03、D-08、E-06、F-12 |
| 声明未接线（守卫/开关/参数/能力位） | **4** | C-01、E-03、B-05、A-1、A-3、B-12、D-02 |
| 两份实现 / 路由遮蔽 | **3** | C-07、F-4、D-11、A-5、B-08、E-11 |
| 文档与实现漂移 | **2** | F-5、F-8、F-9、F-10、C-03（`api.md` 描述"已认证不限速"） |
| 门禁/发布链路假绿（失败被折叠成通过） | **1（但覆盖面最大）** | H-02、H-03、H-05、H-06、H-07、H-12 —— 与 T1「错误折叠成正常值」同源，只是从运行期挪到了 CI 期 |
| 规范强制项无执行点 | **2** | H-01、H-11、E-03、C-01 —— 与「声明未接线」同一形状，出现在启动期与 CI 期 |
| 日志与公共设施的双实现/无原语 | **1** | G-01（限流无原语）、G-10（`getRootDomain` 两份且桶文件导出错的那份）、G-11（请求日志两次，与 C-12 同）、G-12（provider 直建 logger，与 B-12 同） |

## 六、经核实无问题（防误改，共 48 条，摘要 19 条）

完整清单见各分线报告末节（A 7 条 / B 7 条 / C 6 条 / D 6 条 / E 5 条 / F 7 条 / G 7 条 / H 7 条，共 52 条，去重后 48 条）。最容易被"顺手统一"改坏的：

1. `probeDbInitialization` 的 catch 返回 `'unreachable'` 是对的（A/guard-1）——它的职责就是把异常翻译成第三态，**不要**改成 `throw`。
2. `dnspod/adapter.ts:167-177` 是读路径唯一正确样板（B/guard-1）——**不要**把它拉平成 `{total:0,list:[]}`。
3. `registry.ts:352-391` 在模块加载期抛错是"默认拒绝"（B/guard-2）——**不要**改成 warn。
4. `DnsHelper.ts:20-32` 的惰性求值是在躲 `registry → providers → DnsHelper` 的 TDZ 环（B/guard-3）——**不要**改回顶层常量。
5. `app.ts:459-467` 的初始化豁免清单只有 `/api/init` 与 `/api/rdap`（C/F guard）——**不要**为新页面加前缀。
6. `/api/rdap` 的 `{errorCode,title,description}` 是 RFC 7483 要求（C/guard-3）——**不要**套 HiDNS 信封。
7. `i18n` 键覆盖完整（D/guard-1）——"缺翻译"方向不成立；`t('...') || '默认'` 是死回退，不是缺键。
8. `isRecordHost` 与 `isHostnameCheck` 不可合并（D/guard-2）——一个校验主机名（接受 `@`/`*`），一个校验记录值。
9. `taskManager.deferTask`（异步 + 指数退避 + 60 次上限 + 日志限流）已符合规范（E/guard-2）——要修的是超时释放 ID、`concurrency` 死选项、定时器未清，**不是**重排策略。
10. `workflow/store.ts` 与 `workflow/access.ts` 的 fail-closed 是刻意的（E/guard-3/4）——**不要**"容错"成默认值或 `'*'` 通配。
11. 动作命名门禁**已在 CI**（`test-suite.yml:110` 跑 `check:actions`）（E/guard-1）——不要另写脚本或搬进运行时。
12. 路由层**没有**直接导入 `db/dl|dal|dsm|connection`（主审复核）——BAL 直用合规，**不要**为了"分层好看"整体搬进 service。

**H 线（CI / 发布）7 条，摘要 3**：
- `pnpm-workspace.yaml` 的 `allowBuilds` **不是死配置**（pnpm 10 仍识别并映射到 `onlyBuiltDependencies`）——不要按"写法过时"删掉。
- `CHANGELOG` 提取口径与 `docs/CHANGELOG.md` 的 `## [x.y.z] - 日期` 结构完全对得上；三个 `package.json` 当前版本一致——缺的是**校验点**，不是现状。
- E2E 作业先构建并写 `server/data/.env` 播种、用 `exec playwright test`、带 60 次轮询——历史问题已闭环；只跑 2/5 个 project 是显式声明的成本取舍，**不要**按"静默跳过"改。

**G 线（日志 / 公共设施）7 条，摘要 4**：
- `HIDNS_LOG_LEVEL` 默认值与非法值回退正确；敏感键脱敏对 camelCase / snake_case 双归一有效——**不要**按"脱敏不全"重写。
- 单例 + 工厂结构、`createLoggingAdapter` Proxy 真实存在且覆盖全部适配器方法——**不要**改成各 provider 手写日志。
- `saveEnvConfig` 即时生效、`dal/config.ts` 的 `DEFAULT_CONFIG` 是单点——**不要**在别处复制第二份默认值（G-09 的问题正是复制）。
- `app.ts` 三态 + 降级模式、`connection.ts` 的 disconnect/connect 强制约束符合 §481-489——**不要**再"修"一遍。

## 七、修复路线（对齐 root.ai.md）

**阶段 0 · 止血（1-2 天，改 5 处）**
1. `requireInitSurface` 改判 `isInitSurfaceOpen()`；`/database` 与 `/admin` 同守卫（P0-1）。
2. `markInitialized()` 返回落盘结果，失败即拒绝开放初始化面（P0-3）。
3. `dropTablePolicy` 默认改 `'never'`，删除前打印清单并要求显式开启（P0-2）。
4. `recordCountCache` 只在成功时写库（P0-4）。
5. 账号 PUT 识别 `'***'` 掩码（P0-7）。

**阶段 1 · 安全边界（1 周）**：C-02（路径归一化）、C-03（`sendError` 默认 400/500，120 处调用点一次性扫）、C-04（空数组=全放行）、C-05（RDAP 限流改判真实鉴权）、C-06（统一 `getClientIP` 口径）、C-08（SMTP test 加 `noTokenAuth` + 限流）、F-1（令牌权限归一化 + 封顶）。

**阶段 2 · 语义解构（2 周，root.ai.md §DNS提供商适配器）**
1. API 拆 `proxied?: boolean`，`line` 只表示线路（兼容期双收 + 日志计数）。
2. 新增 `lib/dns/line-resolve.ts`：`resolveLine()` 为唯一归一化点，`undefined/''/'0'` → `defaultLineId`。
3. `DnsCapabilities` 增 `lineEditable`、`defaultLineId`；`getRecordLines()` 返回项增 `parentId`、`kind`。
4. 按 provider 逐个修 P0-6 命中的 5 家（powerdns / namesilo / cloudflare / aliyunesa / bt）。

**阶段 3 · 静默失败治理（2 周）**：读接口引入失败通道（以 dnspod 为模板），92 处收敛；`RecordId` 契约（P0-5）；通知层返回结果；工作流 `dns.record.*` 不再硬编码 `'0'`。

**阶段 4 · 契约与门禁（持续）**
1. `docs/api.md` 与 `root.ai.md` 批量修订（F-5、F-8、F-9、F-10、F-12、C-03 描述）。
2. 双 router 遮蔽清理（C-07/F-4），`securityPolicy` 路由要么挂到独立前缀要么删除。
3. `concurrency` 要么落地要么删注释（E-03）；定时任务 ID 去掉 `Date.now()`（E-04/E-05）。
4. 修 CI 假绿（H-02/03/05/06）：Test Summary 判定补 `lint-and-build` 与 `e2e-test`；`test-database` 去掉 `continue-on-error` 与 `|| true`；覆盖率改跑 `test:coverage`；`pr-checks` 的承诺与实际对齐。
5. 修发布链路（H-07/08/09/10）：产物门禁补 `build_windows_arm`、版本三处一致性 + tag 校验 + checkout pin tag、`--frozen-lockfile`、Dockerfile 固定 pnpm/Node 补丁版本、两条 docker 路径只留一个写者。
6. 修日志与公共设施（G-01 至 G-06）：`logger` 增 `throttle` 原语并接入 NS 监控/DB 重连；失败日志统一带 `type/stack`；代理降级回传 `via: 'proxy' | 'direct'`；INFO/DEBUG 的 `[函数名][L行号]` 与 §129-142 二选一（改实现或改规范）。
7. 建议新增三条 CI 门禁（提案，需产品确认）：① provider 契约测试（`getRecordLines` 首项 = `defaultLineId`、create 的 `line` ∈ 列表 id 集）；② `sendError` 第三参 lint；③ "声明未接线"静态检查（导出的守卫/开关函数零引用即失败）。

## 八、主审抽检记录

独立复核（不依赖分线结论，全部亲自读码 / grep）：

| # | 论断 | 复核结果 |
| --- | --- | --- |
| 1 | `isInitSurfaceOpen()` 生产零调用 | ✅ 仅 `app.ts:207` import + 测试引用 |
| 2 | `sendError` 缺省 `statusCode = 200` | ✅ `utils/http.ts:77-83` |
| 3 | 标记文件路径与数据目录解析脱钩 | ✅ `systemState.ts:24-45` vs `dal/config.ts:124-148` |
| 4 | 掩码 `'***'` 链路成立 | ✅ `accounts.ts:137,316` → `Accounts.tsx:48-55` → PUT 跑 `check()` 后原样落库 |
| 5 | powerdns 读回 `Line:'default'` vs 选项 id `'0'` | ✅ `:175` vs `:393` |
| 6 | `recordCountCache` 把 `result.total` 写库 | ✅ `recordCountCache.ts:19-23` |
| 7 | `bt`/`powerdns` 用 `'success'` 当记录 ID | ✅ `bt:206`、`powerdns:244` |
| 8 | `concurrency` 仅声明、全仓无读取 | ✅ 8 处调用方只传不读 |
| 9 | `dropTablePolicy` 默认 `'always'` 且调用点不传 | ✅ `:434`、`init-dsm.ts:28` |
| 10 | `rdapLimiter.skip` 只看 Bearer 头是否存在 | ✅ `rateLimit.ts:94-99` |
| 11 | 工作流硬编码 `'0'` 且 update 不传 `line` | ✅ `record.ts:114,127,194` |
| 12 | Test Summary 判定漏 `lint-and-build` / `e2e-test` | ✅ `test-suite.yml:357-364` 只判 5 个 job |
| 13 | `check_i18n_simple.js` 零引用 | ✅ `grep -rn check_i18n .github scripts package.json` 为空 |
| 14 | 环境校验链是死代码（H-01 修正） | ✅ `validateEnv` 仅被 `getDbConfig` 调用，`getDbConfig` 全仓零调用；但 **JWT_SECRET 长度检查在 `jwt.ts:12-18` 真实生效并 `exit(1)`**——缺的是「未设置时拒绝启动」与 MySQL/PG 参数校验 |
| 15 | 日志限流无中央原语 | ✅ `grep -E 'throttle|sampled|logOnce'` 仅命中事件去重/数组去重；仅 `taskManager.deferTask` 手写了「每 10 次」 |
| 16 | INFO/DEBUG 不输出 `[函数名][L行号]` | ✅ `logger.ts:183` 的 `showCaller` 只在 trace/warn/error 为真，与 §129-142 示例冲突 |
| 17 | `.env` 优先级与规范相反 | ✅ `env.ts:37` 无 override、`:45` 有 override → 实际 `data/.env > process.env > .env` |
| 18 | 代理失败回退直连（G-05 修正） | ✅ `proxy-http.ts:330-343`：**有 warn 日志**，但调用方无法区分，且流量从代理落到直连 |

反向抽检（证明"没问题的确实没问题"）：路由对 `db/*` 的直接导入只有 BAL 两条（合规）；provider 内原生 `fetch` 仅 `resolver` 1 处（`doh-resolver.ts:261`），其余全走 `fetchWithFallback`。

## 九、方法与局限

- 八线范围互斥（A 数据库/初始化、B DNS 适配器与能力模型、C 路由与中间件、D 前端、E 服务与工作流、F 跨层一致性、G 日志与公共设施、H 构建/CI/发布），各自只读代码、独立产出，主审只做去重、抽检与排序，不改写他人结论；分线之间对同一处独立命中的，一律保留并在 §五 标为同源证据。
- 全部结论来自静态阅读（未连接真实数据库、未调用上游 DNS API）。凡涉及上游语义而仓库内无法自证的，分报告已标"待核实"（如 BT `row.state===1` 的语义、阿里云旧 `LineCode` 形态、华为云是否接受 `line="0"`）。
- 未修改任何源码、配置、测试；本轮唯一新增文件是 6 份分线报告与本汇总。
